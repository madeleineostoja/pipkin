import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function reportSetupWarning(
  ctx: ExtensionContext,
  message: string,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    // Print/JSON have no UI; stdout is reserved for the response/protocol.
    process.stderr.write(`${message}\n`);
  }
}
