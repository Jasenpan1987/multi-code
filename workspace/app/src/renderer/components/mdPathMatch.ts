// Finds markdown file paths in a single line of terminal text, for the xterm
// link provider (see TerminalView). Matches paths ending in .md / .markdown so
// they can be turned into clickable links that open in the Markdown View.
//
// Path resolution (absolute / ~ / cwd-relative) is done main-side by the
// read-file IPC, so here we only need to isolate the raw path token; we hand
// the matched text through unchanged.

export interface MdPathMatch {
  path: string; // the matched path text, verbatim
  start: number; // 0-based index of the first char within the line
  end: number; // 0-based index of the last char (inclusive)
}

// A path token: run of "path-ish" characters ending in .md/.markdown. Allowed
// chars deliberately exclude whitespace and common terminal-output delimiters
// (quotes, parens, brackets, backticks, colons, commas, angle brackets) so
// surrounding punctuation isn't swallowed.
//
// The trailing `(?![.\w])` ensures the extension isn't followed by another
// extension or word char: `README.md` matches, but `foo.mdx` and a backup file
// `readme.md.bak` do NOT (the `.bak` would make `.md` a non-final extension).
//
// Global + case-insensitive: iterate all matches on the line; extension check
// is case-insensitive (README.MD counts).
const MD_PATH_RE = /[^\s"'`()[\]<>:,]+\.(?:md|markdown)(?![.\w])/gi;
export function findMdPaths(line: string): MdPathMatch[] {
  const out: MdPathMatch[] = [];
  // Reset lastIndex — the regex is stateful because of the /g flag.
  MD_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_PATH_RE.exec(line)) !== null) {
    const path = m[0];
    const start = m.index;
    out.push({ path, start, end: start + path.length - 1 });
  }
  return out;
}
