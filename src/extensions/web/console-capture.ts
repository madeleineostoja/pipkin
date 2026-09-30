import { AsyncLocalStorage } from "node:async_hooks";
import { formatWithOptions } from "node:util";

const methods = ["debug", "info", "log", "warn", "error", "trace"] as const;
type Method = (typeof methods)[number];
type ConsoleMethod = (...args: unknown[]) => void;

export const CONSOLE_CAPTURE_LIMITS = { entries: 16, characters: 1_000 };

export type ConsoleDiagnostics = {
  entries: { level: Method; text: string; truncated: boolean }[];
  omitted: number;
};

type Router = {
  scopes: AsyncLocalStorage<ConsoleDiagnostics>;
  users: number;
  originals: Map<Method, ConsoleMethod>;
  wrappers: Map<Method, ConsoleMethod>;
};

// The console itself is the shared identity, including across separate Pi Jiti
// loaders. A module singleton would let overlapping sessions restore stale hooks.
const routerKey = Symbol.for("pipkin:web:console-capture");
type RoutedConsole = typeof console & { [routerKey]?: Router };

/** Captures only this operation's console calls, not unrelated concurrent work.
 * Direct stream writes and unawaited background work are outside this boundary.
 */
export async function captureConsole<T>(
  operation: () => T | Promise<T>,
): Promise<{ value: T; diagnostics: ConsoleDiagnostics }> {
  const output = console as RoutedConsole;
  const router = acquire(output);
  const diagnostics: ConsoleDiagnostics = { entries: [], omitted: 0 };
  try {
    const value = await router.scopes.run(diagnostics, operation);
    return { value, diagnostics };
  } finally {
    if (--router.users === 0) {
      for (const [method, wrapper] of router.wrappers) {
        if (output[method] === wrapper) {
          output[method] = router.originals.get(method)!;
        }
      }
      router.scopes.disable();
      delete output[routerKey];
    }
  }
}

function acquire(output: RoutedConsole): Router {
  let router = output[routerKey];
  if (!router) {
    router = {
      scopes: new AsyncLocalStorage<ConsoleDiagnostics>(),
      users: 0,
      originals: new Map(),
      wrappers: new Map(),
    };
    const current = router;
    for (const method of methods) {
      const original = output[method];
      const wrapper: ConsoleMethod = (...args) => {
        const diagnostics = current.scopes.getStore();
        if (diagnostics) {
          record(diagnostics, method, args);
        } else {
          original.apply(output, args);
        }
      };
      current.originals.set(method, original);
      current.wrappers.set(method, wrapper);
      output[method] = wrapper;
    }
    output[routerKey] = current;
  }
  router.users++;
  return router;
}

function record(
  diagnostics: ConsoleDiagnostics,
  level: Method,
  args: unknown[],
): void {
  if (diagnostics.entries.length >= CONSOLE_CAPTURE_LIMITS.entries) {
    diagnostics.omitted++;
    return;
  }
  // Diagnostic formatting must not invoke dependency-provided inspection hooks.
  let text: string;
  try {
    text = formatWithOptions(
      {
        customInspect: false,
        getters: false,
        depth: 2,
        maxArrayLength: 10,
        maxStringLength: CONSOLE_CAPTURE_LIMITS.characters,
      },
      ...args,
    );
  } catch {
    text = "Diagnostic could not be formatted.";
  }
  diagnostics.entries.push({
    level,
    text: text.slice(0, CONSOLE_CAPTURE_LIMITS.characters),
    truncated: text.length > CONSOLE_CAPTURE_LIMITS.characters,
  });
}
