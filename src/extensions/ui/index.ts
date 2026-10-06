import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANNEL } from "./activity.js";
import { ActivityStore } from "./activity-store.js";
import { installActivityWidget } from "./activity-widget.js";
import { installFooter } from "./footer.js";
import { resolveNativeToolRenderers } from "./native-tool-renderers.js";
import { CodemodeProgress } from "./codemode-progress.js";

export default function (pi: ExtensionAPI): void {
  const progress = new CodemodeProgress();
  pi.registerToolRenderer((name, next) =>
    resolveNativeToolRenderers(name, next, progress),
  );
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode === "tui" && event.toolName === "codemode") {
      progress.start(event.toolCallId);
    }
  });
  pi.on("tool_execution_end", (event) => progress.finish(event.toolCallId));
  pi.on("session_start", () => progress.clear());
  pi.on("session_shutdown", () => progress.clear());
  installFooter(pi);
  let disposeActivity: (() => void) | undefined;
  const clearActivity = () => {
    disposeActivity?.();
    disposeActivity = undefined;
  };
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    clearActivity();
    const store = new ActivityStore();
    const unsubscribe = pi.events.on(ACTIVITY_CHANNEL, (event) => {
      try {
        store.accept(event);
      } catch {
        // Activity is a best-effort UI projection.
      }
    });
    const disposeWidget = installActivityWidget(ctx, store);
    disposeActivity = () => {
      unsubscribe();
      disposeWidget();
      store.dispose();
    };
  });
  pi.on("session_shutdown", clearActivity);
}
