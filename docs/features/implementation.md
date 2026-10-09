# Implementation

Implement is Pipkin's autonomous software implementation system. Give it a Markdown plan and it owns dependency-aware scheduling, isolated workspaces, review and repair, serialized publication, and durable evidence.

```text
/implement path/to/plan.md
```

Use it in a disposable checkout before relying on unfamiliar hooks or project conventions.

## Quick start

A plan needs one set of Markdown checkboxes. The least-indented unchecked boxes are executable tasks; nested boxes remain context.

```md
# Release work

## Delivery

- [ ] Add the API endpoint
  - [ ] Return useful validation errors
- [ ] Update the client
- [ ] Document the new flow

[Design notes](docs/design.md)
```

Only unchecked tasks execute. A plan with no unchecked tasks is a no-op.

Start from a clean checkout on a named local branch:

```text
/implement path/to/plan.md
```

A new run requires:

- a resolvable `HEAD` on a named local branch;
- no merge, rebase, cherry-pick, or revert in progress; and
- a clean index and worktree, including nonignored untracked files.

It does not require an upstream, remote, package manager, configured validation command, or hook dry run.

## Plan corpus

Implement follows ordinary local Markdown links recursively and freezes reachable documents as the planning and review corpus. A concise checklist can therefore link to designs and acceptance criteria without repeating them in every task.

| Boundary                    |   Value |
| --------------------------- | ------: |
| Maximum corpus files        |      50 |
| Maximum combined characters | 200,000 |

Missing, unreadable, empty, escaping, or invalid local Markdown targets block the run. Images, external URLs, fragment-only links, and non-Markdown files are not added. Code paths, proposed files, URLs, tickets, and other pointers remain ordinary task instructions.

## Scheduling authority

The source plan defines outcomes, scope, acceptance criteria, and material delivery constraints. Implement owns execution ordering and workstream grouping: checklist order, task numbering, and generic instructions such as “execute sequentially” are advisory. Concrete prerequisites, atomicity requirements, and rollout constraints remain binding; direct user instructions outside the source-plan corpus take precedence.

The planner grounds prerequisites in task contracts and relevant repository source, then groups work at coherent implementation and review boundaries. Every external task prerequisite gates the entire containing workstream; consumers wait for the whole upstream workstream to be delivered. Grouping should not unnecessarily delay independent work or consumers of shared foundations, including through whole-plan verification obligations. Whole-plan review does not substitute for required execution checks. Serial execution remains appropriate when substantive constraints justify it; worker capacity is not a utilization quota.

## Run lifecycle

1. **Plan once.** A high-reasoning planner creates one immutable schedule covering every unchecked task exactly once. It identifies dependencies and groups work at coherent implementation and review boundaries.
2. **Work in isolation.** Eligible workstreams receive owned disposable Git worktrees. Independent streams may run concurrently; dependent streams start from bases containing completed dependencies.
3. **Retain evidence.** Implement records task coverage, candidate provenance, typed verification, and selected durable execution captures. Already-satisfied tasks receive current-repository review instead of manufactured changes.
4. **Review and repair.** Pipkin derives candidate identity from the owned worktree rather than trusting worker-reported Git state. Initial review assesses each ordered contract and the cumulative candidate. Every material finding receives one bounded correction opportunity followed by anchored reassessment.
5. **Publish serially.** One integration lane replays reviewed contributions onto the current target, runs ordinary Git hooks, verifies the prepared commit, and advances the branch with compare-and-swap protection. Conflicting or semantically changed replay goes through bounded reconciliation and fresh review without giving the worker target-write authority.
6. **Review the whole result.** After all source work is delivered, a final reviewer assesses the complete plan. One bounded whole-plan repair and final review may follow. Completed task checkboxes are projected only from durable scheduler state.

Managed agents never run while integration or publication is active, and publication never runs while managed agents are active. The target checkout remains orchestrator-owned throughout.

## Outcomes and recovery

| Outcome              | Meaning                                                                                                                      | Next step                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `completed`          | Every source workstream was delivered and projected, followed by whole-plan review                                           | Read the durable handoff; clean retained history when no longer needed     |
| `incomplete`         | Independent work settled, but some source tasks could not be safely delivered                                                | Inspect evidence, then choose Resume or explicitly clean before a new run  |
| `failed`             | The run was stopped/interrupted or a safety, ownership, persistence, projection, or publication boundary could not be proven | Inspect evidence, then choose Resume when recoverable; clean when finished |
| `dependency_skipped` | A workstream could not run because a direct dependency was unavailable                                                       | Diagnose the causal failed workstream rather than the derivative skip      |

Each settled execution generation captures one concise durable handoff; recoverable preparation or pre-launch startup failure does not consume that generation’s execution outcome. It summarizes delivered state, verification, residual findings, and exact inspection or cleanup commands without dumping forensic details into the transcript.

Pipkin does not roll back published commits, auto-resume a terminal run, or automatically publish retained candidates. Independent successful lanes may remain published when another lane fails. Failed or interrupted workspaces are retained when needed for diagnosis.

Cleanup terminalizes a crash-retained active run as interrupted under the checkout lease without launching workers. It settles durable publication and projection transactions, preserves published target and plan changes, and removes only resources Pipkin can prove it owns.

### Resume

Open `/implement`, select a retained non-completed run, and choose **Resume**. No new plan path is requested. Completed runs keep the separate **Restart** action; Resume is menu-only, not a slash subcommand or model tool.

The menu reads supported state cheaply. Selecting Resume acquires exclusive checkout ownership before checking recoverability and retains that lease through confirmation, preparation, and actor startup. A settled terminal actor in the current session releases ownership before transfer. A live actor, live prior host, or uncertain retained process ownership blocks recovery. Crash-retained execution requires proof that the recorded prior owner is gone; preview does not terminalize it.

The shared Git worktree registry can include other runs' paths that are unavailable in the current container. Resume ignores unrelated unavailable registrations, but still refuses unknown registrations under its own run root and owned branches checked out outside their inventoried workspace.

The confirmation defaults to **Cancel**. It summarizes delivered workstreams to keep and unfinished workstreams to restart, with a disposal warning only when unpublished Git resources remain. **Details** opens a scrollable view of workstream names, exact workspace paths and branches, remaining recovery steps, and retained-plan guarantees. Returning from Details leaves Cancel selected. Confirmation explicitly authorizes disposal of unfinished changes inside proven owned unpublished workspaces, including dirty ones. Declining makes no run-state, workspace, publication, or checkbox changes. It releases acquired ownership; an existing pending preparation stays pending.

Resume refuses unbound planning failures, missing or incompatible state, missing compiled/frozen inputs or required finding evidence, a changed checkout or branch, modified protected plan content, unsafe Git operations, unrelated tracked/staged/nonignored untracked dirt, and externally changed target history. `HEAD` must be the last trusted delivery target or the exact prepared commit proven by an outstanding durable publication intent. Only exact sanctioned checkbox/projection changes are allowed; Resume never stages, commits, discards, or self-heals user dirt to pass preflight.

After confirmation, Resume revalidates observations and atomically reserves one successor with its resource inventory before settlement or deletion. It establishes actual lane/task delivery for an exact landed publication before projecting checkboxes. A provably unlanded intent is abandoned, never newly published for salvage. It discards only inventoried unpublished workspaces and references whose canonical path, durable execution ownership, branch, and confirmed Git-observed contents still match. Delivered evidence and the run directory survive. Missing resources after a recorded removal are idempotent progress; conflicting ownership, escaped paths, reappearing retired resources, or changed workspace contents block preparation.

A preparation failure retains its blockers and completed safe steps. Select Resume again to inspect the remaining steps and confirm continuation of the **same reserved generation**, without another retry grant. Activation follows transaction/task settlement, cleanup, and final exact-target validation. If activation succeeded but no execution began, Resume recovers startup in that same generation. After durable execution-start evidence exists, another interruption requires a newly confirmed successor.

Resume constructs a fresh actor, never attaches to old conversations, and never salvages unpublished candidates or approvals. [Execution generations](#execution-generations) describes preserved delivery, frozen plan identity, finding continuity, complete-plan review, and per-cycle limits.

## Commands

| Command                                           | Purpose                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/implement`                                      | Open the phase-aware menu for current and retained checkout runs                                      |
| `/implement <plan.md>`                            | Start a new run                                                                                       |
| `/implement restart <plan.md> <completed-run-id>` | Preflight a new run, clean the specified completed run, and start again                               |
| `/implement status`                               | Show current and retained outcomes, phases, findings, failures, leases, receipts, and projection debt |
| `/implement inspect <run-id>`                     | Show durable state and evidence paths for one run                                                     |
| `/implement cleanup <run-id>`                     | Settle terminal state and remove provably owned resources after confirmation                          |
| `/implement stop`                                 | Settle owned processes and terminally stop the active run                                             |

The menu also offers **Clean completed runs (N)** for retained completed history. It does not include failed, incomplete, or historical entries. The footer shows a short warning-yellow `cleaning` status while cleanup or automatic post-run resource release is pending, and `preparing` during confirmed Resume preparation.

## Model-facing inspection

| Tool                                    | Purpose                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `implement_list_runs({offset?,limit?})` | Discover authorized current-checkout runs, newest first with stable ID ties                          |
| `implement_inspect({runId})`            | Inspect one known run's bounded phase, workstreams, outcomes, verification, and artifact descriptors |

Both tools are deferred in namespace `implement` and read-only. Pagination defaults to offset `0` and limit `25` (maximum `25`); authorization precedes pagination. Owner enumeration visits at most `1000` directory entries in stable name order and reports `truncated` when incomplete. `nextOffset` appears only when more authorized runs are known. Historical malformed entries and unrelated checkout IDs are not listed. Missing/out-of-checkout targets both return `not_found`; invalid inputs return `invalid_arguments`, and unavailable checkout discovery returns `unavailable`.

Inspection caps each workstream/outcome/verification/artifact inventory at `25`, with bounded text and an overall payload bound. It reports truncation rather than returning mutable internal state or private prompts. Discover artifact descriptors before reading retained files. Execution paths are relative to the run directory; other descriptors identify retained state/corpus/evidence locations. The collapsed row shows a concise run/phase or list summary; expansion shows the same useful typed payload delivered to direct and codemode callers. Managed Implement workers cannot call either operation.

The shared Activity view shows only active Implement work: the generated session title, compact run phase/progress/duration, and active or settlement-waiting workstream lanes. The run's `x/y` reports published tasks across the plan; each source workstream separately shows its assigned task total alongside any duration. Completed lanes disappear immediately; failed lanes remain muted as waiting context only while the parent run is active, and terminal run settlement clears the projection. Workstream duration is shown only when a durable operation timestamp exists. Numbered lanes and expanded dependency/review details follow the [Activity presentation contract](interface-and-personality.md#ui). `/agents` reports the active Implement agent count as non-selectable context but leaves run inspection and control with Implement.

## Target protection and Sandbox

Before and after managed work, Pipkin verifies target checkout and branch identity, absence of unexpected Git operations, cleanliness outside protected plan projection, and exact hashes of protected source material. An unattributable boundary change terminally fails the run and reports affected paths.

| Worker role                                                     | Enabled macOS Sandbox mode           |
| --------------------------------------------------------------- | ------------------------------------ |
| Planner and all reviewers                                       | Repository read-only                 |
| Implementation, revision, reconciliation, and whole-plan repair | Workspace write in an owned worktree |

`/sandbox off` affects later child snapshots only. Linux remains instruction-only, and this trusted-agent defense is not hostile-code isolation. Managed workers may record qualifying Papercuts; that shared personal-metadata write grants no source, Git, or orchestration authority.

Published commits are not rolled back because a later checkbox projection or resource cleanup needs another attempt. Plan checkbox updates are expected dirt while a run is active and ordinary working changes after completion.

## Durable state

Each checkout owns its Implement state:

```text
<checkout>/.pi/pipkin/implement/
  checkout.lock
  checkout.owner.json
  runs/<run-id>/
    execution-plan.json
    source-corpus.json
    run-state.json
    artifacts/
  worktrees/<run-id>/
  trash/
```

`run-state.json` is authoritative. UI, status, evidence views, and Markdown checkboxes are projections. `source-corpus.json` preserves immutable planning input; the execution plan preserves the schedule.

One OS-backed lease protects each checkout's active run and destructive cleanup. Linked checkouts own independent state and may run separately; a second run in the same checkout is rejected. Retained-run cleanup is rejected immediately when another run in the current session owns the checkout. If an external owner blocks bulk cleanup, Implement reports its recorded run and process identity when available, then stops the batch after the first lease timeout instead of repeating that timeout for every remaining run.

Implement reads and writes RunState **v12**. Other schemas are rejected, not converted. Invalid or incompatible artifacts are excluded from model-facing discovery and require manual inspection or removal.

### Execution generations

New runs begin at generation `0`. The run ID, original start commit, compiled task set and worker concurrency, and frozen corpus remain immutable. Each confirmed Resume reserves one monotonically increasing successor; its validated execution target is recorded separately from the original start commit. Fresh unpublished workspaces use that execution target. The [Resume operation](#resume) owns preflight, atomic preparation/activation, resource retirement, and preparation recovery.

Only published source work and durably reviewed satisfaction with delivery receipts survive as delivered. All other source lanes restart ordinary scheduling, including dependency-skipped lanes. Unpublished candidates and old approvals remain evidence, not executable authority. Each generation has the same bounded retry/correction/repair allowances; historical operations cannot consume current capacity or admit late completions. An exhausted cycle requires another explicit Resume, never an automatic loop. A durable execution-start marker is recorded at managed-worker launch admission, after target and worker preflight, or before a host effect can mutate delivery state. A failed activated generation with no launch admission can recover startup in the same generation without resetting attempt accounting; startup failure evidence remains inspectable.

Generation outcomes, failures, operation settlements, candidates, receipts, and prior review assessments remain inspectable. Open source findings travel as complete substantive obligations into fresh implementation and review without requiring a discarded worktree. Fresh reviews must assess each carried ID exactly once; omitted or duplicate assessments reject completion. Carried obligations are bounded to `48,000` serialized characters and refused rather than truncated. Resolved findings stay resolved; recurrences receive new identities. Whole-plan review includes the original full plan, delivered source evidence, every receipted repair's retained verification, and canonical findings, including obligations on delivered source lanes. Unpublished abandoned repairs are not delivered verification. Historical handoff drafts are cumulative context, not approval of a fresh target.

Source and repair workspaces use `worktrees/<run-id>/g<generation>/`; generation-scoped semantic artifacts use `runs/<run-id>/artifacts/g<generation>/`. Verification promotion retains its host-assigned attempt hierarchy below `artifacts/verification/`.

### Verification and execution artifacts

Implementation, revision, reconciliation, and whole-plan repair completions require at least one verification record; reviewers retain their separate finding contracts, without a command requirement.

| Kind         | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `execution`  | Worker selects `label`, `outputRef`, and `claimedOutcome: passed\|failed`; host validates and derives the durable descriptor |
| `inspection` | `label` and concrete `evidence`, explicitly worker-reported rather than host-attested execution                              |
| `not_run`    | `label` and concrete `reason` a check was not performed                                                                      |

Passing claims require completed zero-exit captures from the expected attempt and assigned worktree. Failed claims must match captured failures. Missing/corrupt references, sibling-worker output, wrong worktrees, running snapshots, intentional stops, and false outcome claims reject completion; they are never downgraded to prose.

Implement uses Context's host-held granted export, not worker-chosen filesystem locations. After child producer shutdown flushes and before disposal/scope release, selected validated metadata and bounded output are atomically saved under `runs/<run-id>/artifacts/verification/<hash>.json` in the canonical checkout-owned run directory, even when the parent session starts in a checkout subdirectory. Unavailable-evidence markers use that same run directory. Descriptors retain outcome, execution timing, completeness/truncation, command-preview uncertainty, host-assigned attempt and worker identity, and Git-observed candidate SHA at promotion. They contain artifact-relative references, not transient Context references or child paths. Parent public output lists do not expose private worker captures.

The candidate observed at promotion is provenance, not a claim that every later change was verified: `candidateCoverage: not_attested` explicitly leaves subsequent changes unexcluded. Review packets and handoffs retain typed distinctions and uncertainty. This does not change candidate authority, review acceptance, publication rules, or add a final-candidate test gate.

Finalization also runs on failure, stop, and cancellation, saving only already selected evidence, never all incidental captures. Validation or promotion failure rejects required completion/reliance and records unavailable evidence through the existing failure/candidate artifacts where storage remains available; children and leases are still disposed/released. Source-plan `material-store.ts` is not execution storage.

## Models and concurrency

| Work                                                            | Preset   |
| --------------------------------------------------------------- | -------- |
| Planning and review                                             | `high`   |
| Implementation, revision, reconciliation, and whole-plan repair | `medium` |

`implement.workerConcurrency` defaults to `3` and caps at `8`. Capacity permits parallel work but does not force plan splitting or full utilization. Publication is always serialized.

Implementers choose project-appropriate verification. Pipkin has no configured validation command, automatic command discovery, role-specific persistent model override, or Implement-only reviewer watchdog. Use the shared Activity view for live supervision and `/implement` for run inspection and control.

See [Configuration](../configuration.md) for settings and model presets.

## Development tests

Implement uses separate Vitest projects:

| Project                 | Boundary                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `implement-unit`        | Packets, parser, reducer, scheduler, models, and scripted workers without Git               |
| `implement-integration` | Managed Pi runtime and real-Git worktrees, hooks, replay, index, and publication durability |

```sh
npm run test -- --project implement-unit
npm run test -- --project implement-integration
npm run test -- --project implement-unit --project implement-integration
```

The root `npm run test` remains authoritative.
