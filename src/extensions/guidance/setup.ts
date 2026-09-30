import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadPipkinConfig,
  loadProjectPipkinConfig,
  type ConfigSnapshot,
  type ProjectConfigSnapshot,
} from "#lib/config";
import { gitWorktreeRoot } from "#lib/git";
import { realpath } from "node:fs/promises";

export async function reportConfiguration(
  ctx: ExtensionContext,
  agentDir: string,
): Promise<void> {
  const snapshots: (ConfigSnapshot | ProjectConfigSnapshot)[] = [
    loadPipkinConfig(agentDir),
  ];
  if (ctx.isProjectTrusted()) {
    const root = await gitWorktreeRoot(ctx.cwd).catch(() => realpath(ctx.cwd));
    snapshots.push(loadProjectPipkinConfig(root));
  }
  reportRetiredConfiguration(ctx, snapshots);
}

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
