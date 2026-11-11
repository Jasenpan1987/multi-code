// A click in Claude Code's own input, made into arrow keys (native input,
// 2026-11-11). Claude's classic renderer reads no mouse, but the terminal's cursor
// follows its input caret (Claude Code 2.1.322: Left moves the cursor one character,
// across a line break too), so the number of Left or Right presses from the caret
// to the clicked character is a count of characters. Up and Down are never used:
// on the first or last line they bring back history instead.
//
// The count assumes one hidden character between rows (a line break, or the space
// a word wrap swallows). Where that is wrong (a long word broken mid-word, a
// trailing space the screen doesn't show), the caller looks at where the cursor
// landed and corrects with a second count.

/** Each row of the input, as the screen columns its characters start at. */
export type InputRows = number[][];

export interface InputCell {
  // Row within InputRows, and screen column.
  row: number;
  col: number;
}

/** Where in the input text a cell stands: before the character there, or at the row's end. */
export function inputIndex(rows: InputRows, at: InputCell): number {
  let index = 0;
  for (let r = 0; r < at.row && r < rows.length; r++) index += rows[r].length + 1;
  // A click on the right half of a wide character (CJK) lands after it.
  return index + (rows[at.row] ?? []).filter((start) => start < at.col).length;
}

/** Arrow presses from `from` to `to`: positive for Right, negative for Left. */
export function arrowsBetween(rows: InputRows, from: InputCell, to: InputCell): number {
  return inputIndex(rows, to) - inputIndex(rows, from);
}
