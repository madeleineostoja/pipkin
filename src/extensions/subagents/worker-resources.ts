import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  type EventBus,
} from "@earendil-works/pi-coding-agent";
import { createWorkerDocsExtension } from "./worker-docs.js";
import type { PromptMode } from "./agent-profiles.js";

export async function createChildResourceLoader(options: {
  cwd: string;
  promptInput?: { prompt: string; mode: PromptMode };
  eventBus: EventBus;
}): Promise<{ agentDir: string; resourceLoader: DefaultResourceLoader }> {
  const agentDir = getAgentDir();
  const manifestUrl = new URL("../../../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
    pi: { extensions: string[] };
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    eventBus: options.eventBus,
    additionalExtensionPaths: manifest.pi.extensions.map((path) =>
      fileURLToPath(new URL(path, manifestUrl)),
    ),
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createToolSearchExtension(),
      createWorkerDocsExtension(agentDir),
    ],
    ...(options.promptInput === undefined
      ? {}
      : options.promptInput.mode === "replace"
        ? { systemPrompt: options.promptInput.prompt }
        : { appendSystemPrompt: [options.promptInput.prompt] }),
  });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) {
    throw new Error("Worker extension bundle failed to load.");
  }
  return { agentDir, resourceLoader };
}
