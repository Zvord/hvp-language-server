import { TextDocument } from 'vscode-languageserver-textdocument';

/** Keep the final empty line and all LSP newline forms so completion at EOF
 * uses the same positions as TextDocument and the parser. */
export function getLines(document: TextDocument): string[] {
  return document.getText().split(/\r\n|\r|\n/);
}
