import { FoldingRange } from 'vscode-languageserver-types';
import { PlanDocument } from './planModel';

/** Only correctly matched blocks fold. */
export function provideFoldingRanges(model: PlanDocument): FoldingRange[] {
  return model.foldingRanges;
}
