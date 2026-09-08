import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';

export type Report = (range: Range, code: string, message: string, severity?: DiagnosticSeverity,
                      data?: unknown) => void;

/** One place that knows the shape of a coded HVP diagnostic, shared by the
 * structural and semantic passes. */
export function reporter(diagnostics: Diagnostic[]): Report {
  return (range, code, message, severity = DiagnosticSeverity.Error, data?: unknown) => {
    // `data` rides along on the diagnostic so a later pass can recognise one of
    // its own without re-deriving which node produced it. `workspaceDiagnostics`
    // uses it to drop an `unreferenced-plan` another file answers.
    diagnostics.push({ range, code, message, severity, source: 'hvp', ...(data === undefined ? {} : { data }) });
  };
}
