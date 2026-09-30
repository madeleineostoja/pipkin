import {
  SANDBOX_BASH_LOOKUP_CHANNEL,
  type SandboxBashHost,
  type SandboxBashBinding,
  type SandboxManagedExecutor,
} from "./bash-capability.js";
const managerKey = Symbol.for("pipkin:sandbox:bash");
export function bindSandboxManagedExecutor(
  host: SandboxBashHost,
  startManaged: SandboxManagedExecutor,
): { dispose: () => void } {
  const globalScope = globalThis as Record<symbol, unknown>;
  const manager = (globalScope[managerKey] ??= {
    bindings: new WeakMap<object, SandboxBashBinding>(),
  }) as { bindings: WeakMap<object, SandboxBashBinding> };
  const binding = { token: {}, startManaged };
  manager.bindings.set(host, binding);
  const unsubscribe = host.on?.(SANDBOX_BASH_LOOKUP_CHANNEL, (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { resolve?: unknown }).resolve === "function"
    ) {
      (value as { resolve: (binding: SandboxBashBinding) => void }).resolve(
        binding,
      );
    }
  });
  return {
    dispose() {
      unsubscribe?.();
      if (manager.bindings.get(host)?.token === binding.token) {
        manager.bindings.delete(host);
      }
    },
  };
}
