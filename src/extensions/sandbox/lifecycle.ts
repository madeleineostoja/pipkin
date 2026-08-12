import type {
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  loadPipkinConfig,
  loadProjectPipkinConfig,
  type ConfigSnapshot,
  type ProjectConfigSnapshot,
} from "#lib/config";
import {
  createSandboxBashDefinition,
  createSandboxBashRuntime,
} from "./bash.js";
import { bindSandboxBashExecutor } from "./bash-binding.js";
import type { SandboxBashHost, SandboxBashRequest } from "./bash-capability.js";
import {
  createSandboxDenialObserver,
  type SandboxDenialObserver,
} from "./denial-observer.js";
import type { SandboxDenialRecorder } from "./denials.js";
import { resolveSandboxPolicy } from "./policy.js";
import type { SandboxSessionState } from "./state.js";
import { clearSandboxStatus, syncSandboxStatus } from "./status.js";
import type { SandboxChildSnapshot } from "./write-mode.js";

function initializationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const bounded = Array.from(detail, (character) =>
    /\p{C}/u.test(character) ? "�" : character,
  )
    .join("")
    .slice(0, 240);
  return `Sandbox: initialization failed: ${bounded}`;
}

export function createSandboxSessionController(options: {
  state: SandboxSessionState;
  denials: SandboxDenialRecorder;
  supportedMac: boolean;
  host: SandboxBashHost;
  resolvePolicy?: typeof resolveSandboxPolicy;
  loadGlobalConfig?: (agentDir: string) => ConfigSnapshot;
  loadProjectConfig?: (workspaceRoot: string) => ProjectConfigSnapshot;
  agentDir?: () => string;
  createDenialObserver?: (options: {
    denials: SandboxDenialRecorder;
  }) => SandboxDenialObserver;
}) {
  let bash: ReturnType<typeof createSandboxBashRuntime> | undefined;
  let observer: SandboxDenialObserver | undefined;
  let bashBinding: { dispose: () => void } | undefined;
  let unsubscribeDenials: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;

  return {
    async sessionStart(
      _event: SessionStartEvent,
      ctx: ExtensionContext,
      inherited?: SandboxChildSnapshot | boolean,
    ) {
      bashBinding?.dispose();
      bashBinding = undefined;
      unsubscribeDenials?.();
      unsubscribeDenials = undefined;
      await shutdown;
      shutdown = undefined;
      const previousBash = bash;
      const previousObserver = observer;
      bash = undefined;
      observer = undefined;
      await previousBash?.dispose();
      await previousObserver?.dispose();
      let policy;
      let failure: string | undefined;
      if (options.supportedMac) {
        try {
          const global = (options.loadGlobalConfig ?? loadPipkinConfig)(
            (options.agentDir ?? getAgentDir)(),
          );
          policy = await (options.resolvePolicy ?? resolveSandboxPolicy)({
            sessionCwd: ctx.cwd,
            configurationForWorkspace: (workspaceRoot) => {
              const project = (
                options.loadProjectConfig ?? loadProjectPipkinConfig
              )(workspaceRoot);
              return {
                global: global.config.sandbox?.writable ?? [],
                project: project.config.sandbox.writable,
                issues: [
                  ...global.issues.filter(
                    (issue) =>
                      issue.path === "config" ||
                      issue.path === "sandbox" ||
                      issue.path.startsWith("sandbox."),
                  ),
                  ...project.issues,
                ],
                globalConfigPath: global.path,
                projectConfigPath: project.path,
              };
            },
          });
        } catch (error) {
          failure = initializationError(error);
        }
      }
      const childSnapshot =
        typeof inherited === "boolean"
          ? { enabled: inherited, writeMode: "workspace-write" as const }
          : inherited;
      options.state.reset(policy, failure, childSnapshot?.writeMode);
      if (childSnapshot !== undefined) {
        options.state.setEnabled(childSnapshot.enabled);
      }
      options.denials.reset();
      if (options.supportedMac) {
        try {
          observer = (
            options.createDenialObserver ?? createSandboxDenialObserver
          )({
            denials: options.denials,
          });
          observer.start();
        } catch {
          observer = undefined;
        }
      }
      bash = createSandboxBashRuntime({
        policy,
        enabled: options.state.enabled,
        repositoryReadOnly: options.state.repositoryReadOnly,
        supportedMac: options.supportedMac,
        unavailableReason: failure,
        denialObserver: observer,
      });
      syncSandboxStatus(
        ctx,
        options.state,
        options.supportedMac,
        options.denials,
      );
      unsubscribeDenials = options.denials.subscribe(() =>
        syncSandboxStatus(
          ctx,
          options.state,
          options.supportedMac,
          options.denials,
        ),
      );
      const definition = createSandboxBashDefinition(
        policy?.sessionCwd ?? ctx.cwd,
        bash,
      );
      const execute = (request: SandboxBashRequest) =>
        definition.execute(
          request.toolCallId,
          request.params,
          request.signal,
          request.onUpdate,
          request.ctx,
        );
      bashBinding = bindSandboxBashExecutor(
        options.host,
        execute,
        bash.startManaged,
      );
      return { definition, execute };
    },
    async sessionShutdown(ctx: ExtensionContext): Promise<void> {
      if (!shutdown) {
        const activeBashBinding = bashBinding;
        const activeBash = bash;
        const activeObserver = observer;
        bashBinding = undefined;
        bash = undefined;
        observer = undefined;
        unsubscribeDenials?.();
        unsubscribeDenials = undefined;
        shutdown = (async () => {
          await activeBash?.dispose();
          activeBashBinding?.dispose();
          options.state.revoke();
          clearSandboxStatus(ctx);
          await activeObserver?.dispose();
          options.denials.reset();
        })();
      }
      await shutdown;
    },
  };
}
