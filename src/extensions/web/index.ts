import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCallRenderer } from "#lib/ui/tool-result-renderer";
import { WebFetchParameters, type WebFetchInput } from "./schema.js";
import { WebFetchOutput } from "./result.js";
import { WebFetchOwner } from "./owner.js";
import { renderWebFetchResult } from "./result-renderer.js";

export default function (pi: ExtensionAPI): void {
  const owner = new WebFetchOwner();
  pi.registerTool({
    name: "web_fetch",
    exposure: "direct",
    namespace: {
      name: "web",
      description: "Retrieve bounded credential-free content from public URLs.",
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    label: "Web Fetch",
    description:
      "Retrieve readable content from one known public, credential-free HTTP(S) URL without rendered browser interaction. Returns bounded pretty-printed JSON, extracted Markdown, or plain text; attachments and non-text responses become temporary artifacts. Use Browser when rendered state or interaction is required. Set raw only to save the untouched textual response as an artifact.",
    parameters: WebFetchParameters,
    outputSchema: WebFetchOutput,
    renderCall: toolCallRenderer({
      name: "web_fetch",
      detail: (args: WebFetchInput) => args.url,
      pending: "Fetching public target…",
    }),
    async execute(_toolCallId, input: WebFetchInput, signal, onUpdate) {
      return owner.execute(input, signal, onUpdate);
    },
    renderResult: renderWebFetchResult,
  });
  pi.on("session_shutdown", () => owner.shutdown());
}
