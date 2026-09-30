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
    exposure: "deferred",
    namespace: {
      name: "web",
      description: "Retrieve bounded credential-free content from public URLs.",
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    label: "Web Fetch",
    description:
      "Retrieve bounded public web content from one URL. Automatically returns pretty-printed JSON, extracted markdown, or plain text; attachments and non-text responses become temporary artifacts. Set raw only to preserve an untouched textual response.",
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
