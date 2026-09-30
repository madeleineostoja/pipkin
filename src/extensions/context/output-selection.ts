import {
  truncateHead,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { boundedPreview } from "./retained-output.ts";
import { getImageDimensions } from "@earendil-works/pi-tui";
import {
  type OutputContent,
  OutputSelector,
  type SelectionSchema,
} from "./output-contract.ts";
export function parseLineRange(
  spec: string,
): { start: number; end: number } | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]),
    end = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start > 0 &&
    end >= start
    ? { start, end }
    : undefined;
}
export function selectOutput(
  content: OutputContent,
  selector?: OutputSelector,
): {
  content: OutputContent;
  selection: Static<typeof SelectionSchema>;
  truncated: boolean;
} {
  if (selector && !Value.Check(OutputSelector, selector)) {
    throw new Error("Invalid or mixed output selection");
  }
  if (selector && (content.length !== 1 || content[0]?.type !== "text")) {
    throw new Error("Selection requires one textual source");
  }
  if (content.length !== 1 || content[0]?.type !== "text") {
    let remainingBytes = DEFAULT_MAX_BYTES,
      remainingLines = DEFAULT_MAX_LINES,
      imageBytes = 0,
      truncated = false;
    const selected: OutputContent = [];
    for (const block of content) {
      if (block.type === "image") {
        if (block.data.length > 14 * 1024 * 1024) {
          throw new Error("Image exceeds retrieval bounds");
        }
        imageBytes += Buffer.from(block.data, "base64").length;
        const dimensions = getImageDimensions(block.data, block.mimeType);
        if (
          imageBytes > 10 * 1024 * 1024 ||
          !dimensions ||
          dimensions.widthPx > 4096 ||
          dimensions.heightPx > 12000
        ) {
          throw new Error("Image exceeds retrieval bounds or is invalid");
        }
        selected.push(block);
      } else {
        if (remainingBytes <= 4 || remainingLines <= 0) {
          truncated = true;
          continue;
        }
        const bounded = truncateHead(block.text, {
          maxBytes: remainingBytes,
          maxLines: remainingLines,
        });
        const text = bounded.firstLineExceedsLimit
          ? boundedPreview(block.text, remainingBytes - 4).text + "…"
          : bounded.content;
        selected.push({ type: "text", text });
        remainingBytes -= Buffer.byteLength(text);
        remainingLines -= text.split("\n").length;
        truncated ||= bounded.truncated;
      }
    }
    return { content: selected, selection: { type: "full" }, truncated };
  }
  const text = content[0].text;
  const lines = text.split("\n");
  let selected = text;
  let matchAnchors: number[] = [];
  let comparisonQuery = "";
  let selection: Static<typeof SelectionSchema> = {
    type: "full",
    sourceLines: lines.length,
  };
  if (selector && "lines" in selector) {
    const range = parseLineRange(selector.lines);
    if (!range || range.start > lines.length) {
      throw new Error("Invalid or unavailable line range");
    }
    selected = lines.slice(range.start - 1, range.end).join("\n");
    selection = {
      type: "lines",
      sourceLines: lines.length,
      start: range.start,
      end: Math.min(range.end, lines.length),
      omittedLines:
        lines.length - Math.min(range.end, lines.length) + range.start - 1,
    };
    if (!selected) {
      throw new Error("Requested slice is empty");
    }
  } else if (selector && "tailLines" in selector) {
    selected = lines.slice(-selector.tailLines).join("\n");
    if (!selected) {
      throw new Error("Requested slice is empty");
    }
    selection = {
      type: "tail",
      sourceLines: lines.length,
      start: Math.max(1, lines.length - selector.tailLines + 1),
      end: lines.length,
      omittedLines: Math.max(0, lines.length - selector.tailLines),
    };
  } else if (selector && "find" in selector) {
    const query = selector.find.trim();
    comparisonQuery = stripVTControlCharacters(query).toLowerCase();
    if (!comparisonQuery.trim() || Buffer.byteLength(query) > 256) {
      throw new Error("find must contain 1..256 UTF-8 bytes");
    }
    const matches = lines.flatMap((line, index) =>
      stripVTControlCharacters(line).toLowerCase().includes(comparisonQuery)
        ? [index]
        : [],
    );
    matchAnchors = matches.slice(0, 10);
    const indexes = new Set<number>();
    for (const index of matchAnchors) {
      for (
        let i = Math.max(0, index - 3);
        i <= Math.min(lines.length - 1, index + 3);
        i++
      ) {
        indexes.add(i);
      }
    }
    selected = matches.length
      ? [...indexes]
          .sort((a, b) => a - b)
          .map((index) => `${index + 1} | ${lines[index]}`)
          .join("\n")
      : "No matches.";
    selection = {
      type: "find",
      sourceLines: lines.length,
      totalMatches: matches.length,
      selectedMatches: Math.min(10, matches.length),
      omittedMatches: Math.max(0, matches.length - 10),
      omittedLines: lines.length - indexes.size,
    };
  }
  const bounded = (selection.type === "tail" ? truncateTail : truncateHead)(
    selected,
    {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    },
  );
  // A single pathological line may exceed native head truncation's budget.
  const output = bounded.firstLineExceedsLimit
    ? boundedPreview(selected, DEFAULT_MAX_BYTES - 4).text + "…"
    : bounded.content;
  let returnedLines = Math.min(lines.length, output.split("\n").length);
  if (selection.type === "find") {
    const visible = [...output.matchAll(/^(\d+) \| (.*)$/gm)];
    returnedLines = visible.length;
    const visibleAnchors = visible.filter(
      (match) =>
        matchAnchors.includes(Number(match[1]) - 1) &&
        stripVTControlCharacters(match[2]!)
          .toLowerCase()
          .includes(comparisonQuery),
    ).length;
    selection = {
      ...selection,
      selectedMatches: visibleAnchors,
      omittedMatches: (selection.totalMatches ?? 0) - visibleAnchors,
    };
  } else if (selection.type === "tail") {
    selection = { ...selection, start: lines.length - returnedLines + 1 };
  } else if (selection.type === "lines") {
    selection = { ...selection, end: selection.start! + returnedLines - 1 };
  }
  selection = {
    ...selection,
    returnedLines,
    omittedLines: lines.length - returnedLines,
  };
  return {
    content: [{ type: "text", text: output }],
    selection,
    truncated: bounded.truncated,
  };
}
