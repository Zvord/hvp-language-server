import { FoldingRange } from 'vscode-languageserver-types';
import { analyzeBlocks } from './blockAnalysis';

/**
 * One range per cleanly-matched HVP block pair, falling out of the same
 * frame stack `analyzeBlocks()` walks for diagnostics — a block only
 * contributes a folding range when its close keyword actually matched the
 * open on top of the stack, so a mismatched or unclosed block (already
 * flagged as a diagnostic) doesn't also produce a bogus fold.
 */
export function provideFoldingRanges(lines: string[]): FoldingRange[] {
  return analyzeBlocks(lines).foldingRanges;
}
