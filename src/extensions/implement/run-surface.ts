import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getMarkdownTheme,
  keyHint,
  rawKeyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, type TUI } from "@earendil-works/pi-tui";
import { Panel } from "#lib/ui/panel";
import { ScrollViewport } from "#lib/ui/scroll-viewport";
import { plannerAttemptPath } from "./execution-plan.js";
import { sourceCorpusPath } from "./requirements-context.js";
import { checkoutPaths, failureGeneration, type RunState } from "./store.js";
import { verificationText } from "./verification.js";
import { stripVTControlCharacters } from "node:util";
import type { RunInspection, RunSummary } from "./inspection-schema.js";

type RunSurfaceMode = "overview" | "details";

export async function showImplementRunSurface(
  ctx: ExtensionCommandContext,
  checkoutRoot: string,
  state: RunState,
  mode: RunSurfaceMode,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new ImplementRunSurface(
        tui,
        theme,
        keybindings,
        done,
        checkoutRoot,
        state,
        mode,
      ),
  );
}

class ImplementRunSurface implements Component {
  readonly #scroll: ScrollViewport;
  readonly #panel: Panel;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly done: () => void,
    checkoutRoot: string,
    state: RunState,
    mode: RunSurfaceMode,
  ) {
    const maxRows = Math.max(8, Math.floor((tui.terminal.rows ?? 24) * 0.8));
    this.#scroll = new ScrollViewport({
      content: new Markdown(
        runMarkdown(checkoutRoot, state, mode),
        0,
        0,
        getMarkdownTheme(),
      ),
      viewportHeight: Math.max(1, maxRows - 6),
    });
    this.#panel = new Panel({
      theme,
      title: `Implement · ${state.run.id}`,
      subtitle: `${state.phase} · ${taskProgress(state)}`,
      child: this.#scroll,
      footer: {
        render: () => [
          `${rawKeyHint("↑↓", "scroll")}  ${keyHint("tui.select.cancel", "close")}`,
        ],
        invalidate() {},
      },
    });
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    const up = this.keybindings.matches(data, "tui.select.up");
    const down = this.keybindings.matches(data, "tui.select.down");
    if (up || down) {
      this.#scroll.handleInput(up ? "\x1b[A" : "\x1b[B", {
        homeEnd: true,
      });
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    return this.#panel.render(width);
  }

  invalidate(): void {
    this.#panel.invalidate();
  }
}

export function runMarkdown(
  checkoutRoot: string,
  state: RunState,
  mode: RunSurfaceMode,
): string {
  const paths = checkoutPaths(checkoutRoot);
  const runDirectory = join(paths.runs, state.run.id);
  const worktree = join(paths.worktrees, state.run.id);
  const source = Object.values(state.workstreams.source);
  const overall = Object.values(state.workstreams.overall);
  const workstreams = [
    ...source.map((item) => ({ id: item.id, phase: item.phase })),
    ...overall.map((item) => ({ id: item.repairId, phase: item.phase })),
  ];
  const activeProcesses = Object.values(state.processLeases);
  const openFindings = Object.values(state.findings).filter(
    (finding) => finding.status === "open",
  );
  const openRevisions = Object.values(state.revisionAssignments).filter(
    (revision) => revision.status === "open",
  );
  const receipts = Object.keys(state.publication.receipts).length;
  const intents = Object.keys(state.publication.intents).length;
  const failures = Object.values(state.failures);
  const latestFailure = failures.at(-1) ?? state.failure;
  const publicationUncertainty =
    state.failure?.category === "publication_uncertain"
      ? state.failure.reason
      : failures
          .filter((failure) => failure.category === "publication_uncertain")
          .at(-1)?.evidence;
  const overview = [
    "## Overview",
    `- **Phase:** ${state.phase}`,
    `- **Generation:** ${state.generation} · target ${state.executionTarget}`,
    ...(state.restartPreparation
      ? [
          `- **Restart preparation:** generation ${state.restartPreparation.generation} · ${state.restartPreparation.blockers.join("; ") || "pending prerequisites"}`,
        ]
      : []),
    `- **Tasks:** ${taskProgress(state)}`,
    `- **Workstreams:** ${workstreams.length}`,
    `- **Active processes:** ${activeProcesses.length}`,
    `- **Open findings:** ${openFindings.length}`,
    `- **Open revisions:** ${openRevisions.length}`,
    `- **Publication:** ${receipts}/${intents} receipted`,
    `- **Projection debt:** ${state.projectionDebt.length}`,
  ];
  const sections: string[][] = [overview];
  if (latestFailure) {
    sections.push([
      "## Latest failure",
      `- **${latestFailure.category}:** ${"evidence" in latestFailure ? latestFailure.evidence : latestFailure.reason}`,
      `- **Generation:** ${"id" in latestFailure ? failureGeneration(state, latestFailure.id) : state.generation}`,
    ]);
  }
  if (mode === "overview") {
    return sections.map((section) => section.join("\n")).join("\n\n");
  }

  if (state.generationHistory.length > 0) {
    sections.push([
      "## Prior generations",
      ...state.generationHistory.map(
        (history) =>
          `- **Generation ${history.generation}:** ${history.phase}${history.failure ? ` · ${history.failure.reason}` : ""}`,
      ),
    ]);
  }

  if (state.startupRecoveries.length > 0) {
    sections.push([
      "## Recovered startup failures",
      ...state.startupRecoveries.map(
        (recovery) =>
          `- **Generation ${recovery.generation}:** ${recovery.phase}${recovery.failure ? ` · ${recovery.failure.reason}` : ""}`,
      ),
    ]);
  }

  if (workstreams.length > 0) {
    sections.push([
      "## Workstreams",
      ...workstreams.map((item) => `- **${item.id}:** ${item.phase}`),
    ]);
  }
  if (activeProcesses.length > 0) {
    sections.push([
      "## Active processes",
      ...activeProcesses.map((lease) => `- **${lease.kind}:** ${lease.id}`),
    ]);
  }
  sections.push([
    "## Attention",
    `- Open findings: ${openFindings.length}`,
    ...openFindings.map(
      (finding) => `- **${finding.id}:** ${finding.evidence}`,
    ),
    `- Open revisions: ${openRevisions.length}`,
    ...openRevisions.map(
      (revision) => `- **${revision.id}:** ${revision.status}`,
    ),
  ]);

  const candidates = Object.values(state.candidates);
  if (candidates.length > 0) {
    sections.push([
      "## Candidates",
      ...candidates.map((candidate) => {
        const key =
          candidate.workstream.kind === "source"
            ? `source:${candidate.workstream.id}`
            : `overall:${candidate.workstream.repairId}`;
        const review = state.reviews[key];
        return `- **${candidate.id}:** base ${candidate.baseSha}${candidate.integrationBaseSha ? ` · integration ${candidate.integrationBaseSha}` : ""}${review?.latestCorrection ? ` · ${review.latestCorrection.mode} correction: ${review.latestCorrection.evidence}` : ""}`;
      }),
    ]);
  }

  const reconciliation = Object.values(state.reconciliationAssignments);
  if (reconciliation.length > 0) {
    sections.push([
      "## Reconciliation",
      ...reconciliation.map(
        (assignment) =>
          `- **${assignment.id}:** attempt ${assignment.semanticAttempt} · ${assignment.status} · target ${assignment.targetSha}`,
      ),
    ]);
  }

  if (failures.length > 0 || state.failure) {
    sections.push([
      "## Failures",
      ...failures.map(
        (failure) =>
          `- **${failure.category}:** ${failure.assignment} · ${failure.evidence}`,
      ),
      ...(state.failure
        ? [
            `- **${state.failure.category}:** ${state.failure.reason} · ${state.failure.originPhase}`,
          ]
        : []),
    ]);
  }

  const publication = Object.values(state.publication.intents);
  sections.push([
    "## Publication",
    `- Receipts: ${receipts}/${intents}`,
    `- Superseded: ${Object.keys(state.publication.supersessions).length}`,
    `- Abandoned: ${Object.keys(state.publication.abandonments).length}`,
    ...publication.map((intent) => {
      const receipt = state.publication.receipts[intent.id];
      const supersession = state.publication.supersessions[intent.id];
      const abandonment = state.publication.abandonments[intent.id];
      const outcome = receipt
        ? `published ${receipt.publishedCommitSha}`
        : supersession
          ? `superseded by ${supersession.actualTargetSha}`
          : abandonment
            ? "abandoned"
            : "pending";
      return `- **${intent.id}:** target ${intent.targetBaseSha} · ${outcome}`;
    }),
    ...(publicationUncertainty
      ? [`- **Uncertainty:** ${publicationUncertainty}`]
      : []),
  ]);

  const evidence = projectRunSurface(checkoutRoot, state);
  if (evidence.verification.length) {
    sections.push([
      "## Verification",
      ...evidence.verification.map(
        (record) => `- **${record.kind}:** ${record.text}`,
      ),
      ...(evidence.truncated
        ? [
            "- Projection bounded; inspect retained artifacts for more evidence.",
          ]
        : []),
    ]);
  }

  const executionPlan = join(runDirectory, "execution-plan.json");
  const sourceCorpus = sourceCorpusPath(runDirectory);
  const plannerAttempt = plannerAttemptPath(runDirectory);
  const artifacts = join(runDirectory, "artifacts");
  sections.push([
    "## Paths",
    `- State: ${join(runDirectory, "run-state.json")}`,
    `- Source plan: ${state.run.source.entry.path}`,
    `- Planner attempt: ${retainedPath(plannerAttempt)}`,
    `- Execution plan: ${retainedPath(executionPlan)}`,
    `- Source corpus: ${retainedPath(sourceCorpus)}`,
    `- Artifacts: ${retainedPath(artifacts)}`,
    `- Retained worktree: ${existsSync(worktree) ? worktree : "none"}`,
  ]);

  return sections.map((section) => section.join("\n")).join("\n\n");
}

const surfaceText = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{C}/gu, " ").slice(0, 1500);

export function runSummary(state: RunState): RunSummary {
  const tasks = Object.values(state.tasks);
  return {
    runId: surfaceText(state.run.id),
    phase: state.phase,
    generation: state.generation,
    restartPending: state.restartPreparation !== undefined,
    createdAt: surfaceText(state.createdAt),
    updatedAt: surfaceText(state.updatedAt),
    tasks: tasks.length,
    publishedTasks: tasks.filter((task) => task.phase === "published").length,
  };
}

export function projectRunSurface(
  checkoutRoot: string,
  state: RunState,
): RunInspection {
  const runDirectory = join(checkoutPaths(checkoutRoot).runs, state.run.id);
  let truncated = false;
  const bounded = (text: string) => {
    truncated ||= text.length > 1500;
    return surfaceText(text);
  };
  const take = <T>(items: T[]): T[] => {
    truncated ||= items.length > 25;
    return items.slice(0, 25);
  };
  const artifacts: RunInspection["artifacts"] = [
    {
      kind: "state",
      path: join(runDirectory, "run-state.json"),
      retained: true,
    },
    {
      kind: "execution_plan",
      path: join(runDirectory, "execution-plan.json"),
      retained: existsSync(join(runDirectory, "execution-plan.json")),
    },
    {
      kind: "source_corpus",
      path: sourceCorpusPath(runDirectory),
      retained: existsSync(sourceCorpusPath(runDirectory)),
    },
    {
      kind: "planner_attempt",
      path: plannerAttemptPath(runDirectory),
      retained: existsSync(plannerAttemptPath(runDirectory)),
    },
    {
      kind: "artifacts",
      path: join(runDirectory, "artifacts"),
      retained: existsSync(join(runDirectory, "artifacts")),
    },
  ];
  const verification: RunInspection["verification"] = [];
  const add = (
    candidateId: string,
    context: "implementation" | "correction",
    evidence:
      | NonNullable<RunState["candidates"][string]["implementationEvidence"]>
      | undefined,
  ) => {
    if (!evidence) {
      return;
    }
    if (evidence.artifactPath) {
      artifacts.push({
        kind: "evidence",
        path: evidence.artifactPath,
        retained: existsSync(evidence.artifactPath),
        candidateId: bounded(candidateId),
      });
    }
    for (const record of evidence.verification) {
      const descriptor: RunInspection["verification"][number] = {
        kind: record.kind,
        candidateId: bounded(candidateId),
        context,
        text: bounded(verificationText(record)),
      };
      if (record.kind === "execution") {
        Object.assign(descriptor, {
          artifactPath: record.artifactPath,
          attemptId: bounded(record.attemptId),
          candidateCommitSha: bounded(record.candidateCommitSha),
          capturedAt: record.capturedAt,
          outcome: record.outcome,
          truncated: record.truncated,
          commandTruncated: record.commandTruncated,
          candidateCoverage: record.candidateCoverage,
          sourceTool: record.sourceTool,
          executionState: record.execution.state,
          exitCode: record.execution.exitCode,
          outputComplete: record.outputComplete,
          droppedBytes: record.droppedBytes,
          startedAt: record.execution.startedAt,
          endedAt: record.execution.endedAt,
        });
        artifacts.push({
          kind: "execution",
          path: record.artifactPath,
          retained: existsSync(join(runDirectory, record.artifactPath)),
          candidateId: bounded(candidateId),
          attemptId: bounded(record.attemptId),
          outcome: record.outcome,
        });
      }
      verification.push(descriptor);
    }
  };
  for (const candidate of Object.values(state.candidates)) {
    add(candidate.id, "implementation", candidate.implementationEvidence);
  }
  const retainedReviews = [
    ...Object.values(state.reviews),
    ...state.reviewHistory.flatMap((history) => Object.values(history.reviews)),
  ];
  const reviewed = new Set<string>();
  for (const review of retainedReviews) {
    const identity = JSON.stringify([
      review.candidateId,
      review.latestCorrection,
    ]);
    if (reviewed.has(identity)) {
      continue;
    }
    reviewed.add(identity);
    const correction = review.latestCorrection;
    if (correction?.verification) {
      add(review.candidateId, "correction", {
        ...correction,
        summary: correction.summary ?? correction.evidence,
        verification: correction.verification,
      });
    }
  }
  const workstreams = take([
    ...Object.values(state.workstreams.source).map((item) => ({
      id: bounded(item.id),
      phase: item.phase,
    })),
    ...Object.values(state.workstreams.overall).map((item) => ({
      id: bounded(item.repairId),
      phase: item.phase,
    })),
  ]);
  const outcomes = take([
    ...(state.restartPreparation
      ? [
          {
            kind: "restart_preparation",
            text: bounded(
              `Generation ${state.restartPreparation.generation}: ${state.restartPreparation.blockers.join("; ") || "pending prerequisites"}`,
            ),
          },
        ]
      : []),
    ...state.generationHistory.map((history) => ({
      kind: "generation_outcome",
      text: bounded(
        `Generation ${history.generation}: ${history.phase}${history.failure ? ` · ${history.failure.reason}` : ""}`,
      ),
    })),
    ...state.startupRecoveries.map((recovery) => ({
      kind: "startup_recovery",
      text: bounded(
        `Generation ${recovery.generation}: ${recovery.phase}${recovery.failure ? ` · ${recovery.failure.reason}` : ""}`,
      ),
    })),
    ...Object.values(state.failures).map((failure) => ({
      kind: failure.category,
      text: bounded(
        `Generation ${failureGeneration(state, failure.id)}: ${failure.evidence}`,
      ),
    })),
    ...Object.values(state.findings)
      .filter((finding) => finding.status === "open")
      .map((finding) => ({
        kind: "open_finding",
        text: bounded(finding.evidence),
      })),
    ...Object.values(state.publication.receipts).map((receipt) => ({
      kind: "publication",
      text: bounded(receipt.publishedCommitSha),
    })),
    ...Object.values(state.candidates).flatMap((candidate) => [
      ...(candidate.evidenceStatus === "unavailable"
        ? [
            {
              kind: "evidence_unavailable",
              text: bounded(`${candidate.id}: worker evidence unavailable`),
            },
          ]
        : []),
      ...(candidate.implementationEvidence?.uncertainty
        ? [
            {
              kind: "verification_uncertainty",
              text: bounded(
                `${candidate.id}: ${candidate.implementationEvidence.uncertainty}`,
              ),
            },
          ]
        : []),
    ]),
    ...Object.values(state.reviews).flatMap((review) =>
      review.latestCorrection?.uncertainty
        ? [
            {
              kind: "verification_uncertainty",
              text: bounded(
                `${review.candidateId}: ${review.latestCorrection.uncertainty}`,
              ),
            },
          ]
        : [],
    ),
    ...(state.failure
      ? [{ kind: state.failure.category, text: bounded(state.failure.reason) }]
      : []),
  ]);
  const result: RunInspection = {
    ...runSummary(state),
    workstreams,
    outcomes,
    verification: take(verification),
    artifacts: take(
      artifacts.filter((artifact) => {
        const exact =
          artifact.path.length <= 2000 &&
          stripVTControlCharacters(artifact.path) === artifact.path &&
          !/\p{C}/u.test(artifact.path);
        truncated ||= !exact;
        return exact;
      }),
    ),
    truncated,
  };
  // Keep direct and structured payloads identically bounded, not just the renderer.
  while (Buffer.byteLength(JSON.stringify(result)) > 48_000) {
    const arrays = [
      result.outcomes,
      result.verification,
      result.artifacts,
      result.workstreams,
    ];
    arrays.sort((a, b) => b.length - a.length)[0]!.pop();
    result.truncated = true;
  }
  return result;
}

function retainedPath(path: string): string {
  return existsSync(path) ? path : `${path} (not retained)`;
}

function taskProgress(state: RunState): string {
  const tasks = Object.values(state.tasks);
  const completed = tasks.filter((task) => task.phase === "published").length;
  return `${completed}/${tasks.length}`;
}
