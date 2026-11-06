// The first sentence of a brief (epic secretary-bar): the phone bar's folded line and
// the body of the push the brief's event gets. A brief is written to be spoken
// (voice-secretary Story 4), plain text with no Markdown, and opens with its session's
// name ("Shop 那边……"), so its first sentence says whose news it is.

// A sentence end sooner than this doesn't end it ("OK." alone says nothing).
const MIN_CHARS = 8;
// Without a sentence end by then, the line is cut here.
const MAX_CHARS = 140;

export function briefSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const ends = /[.!?](?=\s|$)|[。！？]/g;
  for (let m = ends.exec(line); m && m.index < MAX_CHARS; m = ends.exec(line)) {
    if (m.index + 1 >= MIN_CHARS) return line.slice(0, m.index + 1);
  }
  const chars = Array.from(line);
  return chars.length > MAX_CHARS ? `${chars.slice(0, MAX_CHARS - 1).join("")}…` : line;
}
