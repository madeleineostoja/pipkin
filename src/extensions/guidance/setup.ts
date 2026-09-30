import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigSnapshot, ProjectConfigSnapshot } from "#lib/config";

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

export function reportRetiredConfiguration(
  ctx: ExtensionContext,
  snapshots: readonly (ConfigSnapshot | ProjectConfigSnapshot)[],
): void {
  for (const snapshot of snapshots) {
    const issue = snapshot.issues.find((issue) => issue.path === "mcp");
    if (issue) {
      reportSetupWarning(
        ctx,
        `Pipkin configuration: ${issue.scope} mcp ${issue.message}`,
      );
    }
  }
}
