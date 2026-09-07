import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';

export type Report = (range: Range, code: string, message: string, severity?: DiagnosticSeverity) => void;

/** One place that knows the shape of a coded HVP diagnostic, shared by the
 * structural and semantic passes. */
export function reporter(diagnostics: Diagnostic[]): Report {
  return (range, code, message, severity = DiagnosticSeverity.Error) => {
    diagnostics.push({ range, code, message, severity, source: 'hvp' });
  };
}
