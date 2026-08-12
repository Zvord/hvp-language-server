import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver-types';

/**
 * `TextDocument` (unlike vscode's `TextDocument`) has no `lineCount` /
 * `lineAt(i)` — only `getText()`. Every core module works off a plain
 * `string[]` instead, split once per lint pass.
 *
 * A trailing newline is dropped rather than kept as one more empty line, to
 * match vscode.TextDocument's line model (what the golden baseline was
 * captured against).
 */
export function getLines(document: TextDocument): string[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

export function lineRange(lines: string[], line: number): Range {
  return Range.create(line, 0, line, lines[line].length);
}
