import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
export type SandboxBashHost = ExtensionAPI["events"];
export type SandboxOutputEvent = Readonly<{
  stream: "stdout" | "stderr";
  data: Buffer;
}>;
export type SandboxExecutionTerminal = Readonly<{
  exitCode: number | null;
  signal: string | null;
  termination: "natural" | "stopped" | "shutdown";
  outputComplete: boolean;
}>;
export class SandboxCleanupError extends Error {
  readonly code = "sandbox_cleanup_failed";
  constructor(
    message: string,
    readonly execution: SandboxExecutionTerminal,
  ) {
    super(message);
  }
}

// Capability consumers can run under another Jiti instance; do not rely on
// Error subclass identity to recover the known execution diagnostics.
export function sandboxCleanupExecution(
  error: unknown,
): SandboxExecutionTerminal | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "sandbox_cleanup_failed" ||
    !("execution" in error)
  ) {
    return undefined;
  }
  const data = error.execution;
  if (
    !data ||
    typeof data !== "object" ||
    !("exitCode" in data) ||
    !("signal" in data) ||
    !("termination" in data) ||
    !("outputComplete" in data) ||
    !(
      data.exitCode === null ||
      (typeof data.exitCode === "number" && Number.isInteger(data.exitCode))
    ) ||
    !(data.signal === null || typeof data.signal === "string") ||
    !(
      data.termination === "natural" ||
      data.termination === "stopped" ||
      data.termination === "shutdown"
    ) ||
    typeof data.outputComplete !== "boolean"
  ) {
    return undefined;
  }
  return {
    exitCode: data.exitCode,
    signal: data.signal,
    termination: data.termination,
    outputComplete: data.outputComplete,
  };
}
export type SandboxExecutionLease = Readonly<{
  pid: number;
  completion: Promise<SandboxExecutionTerminal>;
  stop: () => Promise<SandboxExecutionTerminal>;
}>;
export type SandboxManagedRequest = Readonly<{
  toolCallId: string;
  command: string;
  cwd: string;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  onOutput: (event: SandboxOutputEvent) => void;
}>;
export type SandboxManagedExecutor = (
  request: SandboxManagedRequest,
) => Promise<SandboxExecutionLease>;
export type SandboxBashBinding = {
  token: object;
  startManaged: SandboxManagedExecutor;
};
export const SANDBOX_BASH_LOOKUP_CHANNEL = "pipkin:sandbox:bash-lookup";
const managerKey = Symbol.for("pipkin:sandbox:bash");
export async function startSandboxManagedExecution(
  host: SandboxBashHost,
  request: SandboxManagedRequest,
): Promise<SandboxExecutionLease> {
  const manager = (globalThis as Record<symbol, unknown>)[managerKey] as
    | { bindings: WeakMap<object, SandboxBashBinding> }
    | undefined;
  let binding = manager?.bindings.get(host);
  if (!binding && typeof host.emit === "function") {
    host.emit(SANDBOX_BASH_LOOKUP_CHANNEL, {
      resolve: (value: SandboxBashBinding) => {
        binding ??= value;
      },
    });
  }
  if (!binding) {
    throw new Error("Sandbox: managed execution is unavailable.");
  }
  return binding.startManaged(request);
}
