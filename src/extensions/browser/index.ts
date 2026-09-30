import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowserOperations } from "./operations.js";
import { BrowserOwner } from "./owner.js";

export default function (pi: ExtensionAPI): void {
  const owner = new BrowserOwner();
  registerBrowserOperations(pi, owner);
  pi.on("session_start", () => owner.reset());
  pi.on("session_shutdown", () => owner.shutdown());
}
