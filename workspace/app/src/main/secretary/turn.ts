// What the builder last said in a Claude session, and what happened since: the
// brief writer's material, read from the session's JSONL.
//
// The builder's messages come from the raw rows, not from `readClaudeTranscript`,
// which keeps every `isMeta` row with string content as a "user" entry and drops
// every typed message whose content is an array. In a survey of the builder's own
// transcripts that meant 25 `[Image: original 2400x1600, …]` lines the CLI added,
// which would hand the brief writer an English "latest message" and flip a Chinese
// builder's brief, and 40 real messages lost because they carried a pasted image
// (docs/timeline/2026-10-08_brief-writer-spike.md, "Input format").
//
// The turn itself is `readClaudeTranscript`'s entries over the rows after that
// message, so it reads the way the phone and the manager see a session.

import fs from "fs";
import { claudeTranscriptEntries } from "../backends/claude";
import type { TranscriptEntry } from "../../shared/remote-protocol";

// For the language rule only: a bare "B" or "[Image #1]" as the latest message
// falls back to these, newest first.
export const EARLIER_MESSAGES = 3;

export interface BuilderTurn {
  // Absent when the session has no message the builder typed.
  builderLatestMessage?: string;
  // Up to three typed before it, oldest first.
  builderEarlierMessages: string[];
  // Everything after the latest message, or the whole session when there is none.
  turn: TranscriptEntry[];
}

// The text of a row the builder typed, or null for anything else: rows the CLI
// adds (`isMeta`: image notes, "Continue from where you left off.", messages from
// other sessions), tool results, the CLI's own tagged rows (`<command-name>`,
// `<bash-input>`, `<task-notification>`, `<local-command-…>`) and the interruption
// marker. Text parts of an array body count, so a message with a pasted image is
// still the builder's.
export function typedText(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  if (record.type !== "user" || record.isMeta === true) return null;
  // The summary a compaction writes as a user row. Not seen in the builder's
  // transcripts; skipped because it is long English text the builder never typed.
  if (record.isCompactSummary === true) return null;

  const content = (record.message as Record<string, unknown> | undefined)?.content;
  let text: string;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts = content as Record<string, unknown>[];
    if (parts.some((part) => part?.type === "tool_result")) return null;
    text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
  } else {
    return null;
  }

  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null;
  return text;
}

export function builderTurnFromLines(lines: string[]): BuilderTurn {
  // Backwards, because a session runs to thousands of rows and only its end matters.
  const typed: { index: number; text: string }[] = [];
  for (let i = lines.length - 1; i >= 0 && typed.length <= EARLIER_MESSAGES; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const text = typedText(row);
    if (text !== null) typed.push({ index: i, text });
  }

  const [latest, ...earlier] = typed;
  return {
    builderLatestMessage: latest?.text,
    builderEarlierMessages: earlier.reverse().map((message) => message.text),
    turn: claudeTranscriptEntries(latest ? lines.slice(latest.index + 1) : lines),
  };
}

// Null when the transcript can't be read.
export async function readBuilderTurn(jsonlPath: string): Promise<BuilderTurn | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }
  return builderTurnFromLines(raw.split("\n"));
}
