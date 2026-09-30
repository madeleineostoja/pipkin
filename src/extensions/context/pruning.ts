import type {
  BoundaryState,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  coldMarkerId,
  pruneAtBoundary,
  restorePolicy,
  warnAppendFailure,
} from "./elision.ts";
import { createPruningState } from "./policy.ts";

export function createPruningFlow() {
  let state = createPruningState();
  return {
    sessionStart(ctx: ExtensionContext): void {
      state = createPruningState();
      restorePolicy(state, ctx.sessionManager.getBranch(), ctx);
    },
    requestStart(ctx: ExtensionContext): void {
      // Even a warming or failed request closes this cold window.
      state.warmedMarkerId = coldMarkerId(ctx.sessionManager.getBranch());
    },
    boundary(event: BoundaryState, ctx: ExtensionContext) {
      try {
        return pruneAtBoundary(state, event, ctx);
      } catch {
        warnAppendFailure(state, ctx);
        return undefined;
      }
    },
  };
}
