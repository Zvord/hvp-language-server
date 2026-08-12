import { Diagnostic, DiagnosticSeverity, FoldingRange, Range } from 'vscode-languageserver-types';
import { lineRange } from './textLines';
import { BLOCK_CLOSE_KEYWORD, BLOCK_OPEN_KEYWORD, PairKind } from './keywords';

export interface MaskState {
  inBlockComment: boolean;
}

/**
 * Blanks out comment and string-literal content on a line so keyword regexes
 * never match text that only *looks* like `feature`/`endfeature` inside a
 * string (e.g. a description) or a comment. Column positions are preserved.
 */
export function maskLine(line: string, state: MaskState): string {
  const out: string[] = new Array(line.length).fill(' ');
  let i = 0;
  let inString = false;

  if (state.inBlockComment) {
    const end = line.indexOf('*/');
    if (end === -1) {
      return out.join('');
    }
    i = end + 2;
    state.inBlockComment = false;
  }

  while (i < line.length) {
    if (inString) {
      if (line[i] === '\\' && i + 1 < line.length) {
        i += 2;
        continue;
      }
      if (line[i] === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (line[i] === '"') {
      inString = true;
      i++;
      continue;
    }

    if (line[i] === '/' && line[i + 1] === '/') {
      break;
    }

    if (line[i] === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        state.inBlockComment = true;
        break;
      }
      i = end + 2;
      continue;
    }

    out[i] = line[i];
    i++;
  }

  return out.join('');
}

export const FEATURE_OPEN = /^\s*feature\s+([A-Za-z_]\w*)\s*;/;
export const FEATURE_CLOSE = /^\s*endfeature\b/;
export const MEASURE_OPEN = /^\s*measure\s+(.+);\s*$/;
export const MEASURE_CLOSE = /^\s*endmeasure\b/;
export const SOURCE_ASSIGNMENT = /^\s*source\b\s*=/;

// Bare block-closer keywords are statements in their own right and never take
// a trailing semicolon (see the HVP BNF: `endfeature`, `endmeasure`, etc. close
// a block on their own line). Everything else is expected to end in `;`, so
// missing-semicolon detection only needs to special-case these. Derived from
// BLOCK_CLOSE_KEYWORD so the two can't drift apart.
const SEMICOLON_EXEMPT = new RegExp(`^\\s*(${Object.values(BLOCK_CLOSE_KEYWORD).join('|')})\\s*$`);

interface PairSpec {
  kind: PairKind;
  // Group 1, when present, is the block's declared name/type-expression.
  openRegex: RegExp;
  closeRegex: RegExp;
}

// `metric`'s open declaration can span a bracketed type list (e.g.
// `metric enum {pass, fail} Result;`, `metric aggregate {Line(weight=1.0)} Score;`),
// so — like `measure` — it needs a "capture everything up to `;`" shape rather
// than a plain identifier regex.
//
// `until`/`elseuntil`/`else`/`enduntil` is a 3-way branch, not a simple pair:
// only `until` opens a frame and only `enduntil` closes it. `elseuntil`/`else`
// are branches *within* that same logical block, so they deliberately have no
// entry here and never touch the block stack.
const PAIR_SPECS: PairSpec[] = [
  { kind: 'plan', openRegex: /^\s*plan\s+([A-Za-z_]\w*)\s*;/, closeRegex: /^\s*endplan\b/ },
  { kind: 'feature', openRegex: FEATURE_OPEN, closeRegex: FEATURE_CLOSE },
  { kind: 'metric', openRegex: /^\s*metric\s+(.+);\s*$/, closeRegex: /^\s*endmetric\b/ },
  { kind: 'measure', openRegex: MEASURE_OPEN, closeRegex: MEASURE_CLOSE },
  { kind: 'override', openRegex: /^\s*override\s+([A-Za-z_]\w*)\s*;/, closeRegex: /^\s*endoverride\b/ },
  { kind: 'filter', openRegex: /^\s*filter\s+([A-Za-z_]\w*)\s*;/, closeRegex: /^\s*endfilter\b/ },
  { kind: 'until', openRegex: /^\s*until\s+.+;\s*$/, closeRegex: /^\s*enduntil\b/ },
];

interface BlockFrame {
  kind: PairKind;
  line: number;
  name?: string;
}

export interface LineSnapshot {
  /** Open block kinds, bottom to top, as they stand at the *start* of this line. */
  stack: PairKind[];
  /** Whether an unterminated block comment was already open entering this line. */
  inBlockComment: boolean;
}

export interface BlockAnalysisResult {
  diagnostics: Diagnostic[];
  lineSnapshots: LineSnapshot[];
  foldingRanges: FoldingRange[];
}

function keywordRange(lines: string[], line: number, masked: string, keyword: string): Range {
  const idx = masked.indexOf(keyword);
  if (idx === -1) {
    return lineRange(lines, line);
  }
  return Range.create(line, idx, line, idx + keyword.length);
}

function error(range: Range, message: string): Diagnostic {
  return { range, message, severity: DiagnosticSeverity.Error, source: 'hvp' };
}

function warning(range: Range, message: string): Diagnostic {
  return { range, message, severity: DiagnosticSeverity.Warning, source: 'hvp' };
}

/**
 * Scans a document for structural problems the HVP grammar can't catch via
 * syntax highlighting alone: statements missing their terminating `;`,
 * `feature` blocks with no nested feature/measure (dead weight in the plan),
 * `measure` blocks with no `source`, and — treating every HVP block pair
 * (`feature`/`endfeature`, `measure`/`endmeasure`, `metric`/`endmetric`,
 * `plan`/`endplan`, `override`/`endoverride`, `filter`/`endfilter`,
 * `until`/`enduntil`) like matching parentheses — unclosed blocks left open
 * at EOF, and close keywords with no (or the wrong) matching open.
 *
 * Also returns a per-line snapshot of the open-block stack, reused by the
 * completion provider so it doesn't need to rescan the document on every
 * keystroke to figure out what kind of block the cursor is currently inside.
 */
export function analyzeBlocks(lines: string[]): BlockAnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const maskState: MaskState = { inBlockComment: false };
  const lineSnapshots: LineSnapshot[] = [];
  const foldingRanges: FoldingRange[] = [];

  const featureStack: { line: number; name: string; hasChild: boolean; hasMeasure: boolean }[] = [];
  const measureStack: { line: number; name: string; hasSource: boolean }[] = [];
  const blockStack: BlockFrame[] = [];

  const closeFrame = (kind: PairKind, line: number, masked: string) => {
    const closeKeyword = BLOCK_CLOSE_KEYWORD[kind];
    const range = keywordRange(lines, line, masked, closeKeyword);
    const top = blockStack[blockStack.length - 1];

    if (!top) {
      diagnostics.push(
        error(range, `Unexpected '${closeKeyword}': no matching '${BLOCK_OPEN_KEYWORD[kind]}' block is open here.`)
      );
      return;
    }

    if (top.kind !== kind) {
      const expectedClose = BLOCK_CLOSE_KEYWORD[top.kind];
      diagnostics.push(
        error(
          range,
          `Mismatched close: expected '${expectedClose}' to close '${BLOCK_OPEN_KEYWORD[top.kind]}' opened at line ${
            top.line + 1
          }, but found '${closeKeyword}'.`
        )
      );
      // Best-effort resync: pop the top frame anyway so one typo doesn't
      // cascade into a diagnostic on every subsequent close in the file.
      blockStack.pop();
      return;
    }

    blockStack.pop();
    if (line > top.line) {
      foldingRanges.push(FoldingRange.create(top.line, line));
    }
  };

  for (let i = 0; i < lines.length; i++) {
    lineSnapshots[i] = { stack: blockStack.map((frame) => frame.kind), inBlockComment: maskState.inBlockComment };

    const raw = lines[i];
    const masked = maskLine(raw, maskState);
    const trimmed = masked.replace(/\s+$/, '');

    if (
      trimmed.length > 0 &&
      !trimmed.endsWith(';') &&
      !trimmed.endsWith(',') &&
      !SEMICOLON_EXEMPT.test(trimmed)
    ) {
      const range = Range.create(i, trimmed.length - 1, i, trimmed.length);
      diagnostics.push(error(range, 'Statement is missing a terminating semicolon (\';\').'));
    }

    let handled = false;
    for (const spec of PAIR_SPECS) {
      const openMatch = spec.openRegex.exec(masked);
      if (openMatch) {
        if (spec.kind === 'feature') {
          if (featureStack.length > 0) {
            featureStack[featureStack.length - 1].hasChild = true;
          }
          featureStack.push({ line: i, name: openMatch[1], hasChild: false, hasMeasure: false });
        } else if (spec.kind === 'measure') {
          const tokens = openMatch[1].trim().split(/\s+/);
          const name = tokens[tokens.length - 1];
          if (featureStack.length > 0) {
            featureStack[featureStack.length - 1].hasMeasure = true;
          }
          measureStack.push({ line: i, name, hasSource: false });
        }
        blockStack.push({ kind: spec.kind, line: i, name: openMatch[1] });
        handled = true;
        break;
      }

      if (spec.closeRegex.test(masked)) {
        if (spec.kind === 'feature') {
          const top = featureStack.pop();
          if (top && !top.hasChild && !top.hasMeasure) {
            diagnostics.push(
              warning(lineRange(lines, top.line), `Feature '${top.name}' is empty: it has no nested features or measures.`)
            );
          }
        } else if (spec.kind === 'measure') {
          const top = measureStack.pop();
          if (top && !top.hasSource) {
            diagnostics.push(warning(lineRange(lines, top.line), `Measure '${top.name}' has no source.`));
          }
        }
        closeFrame(spec.kind, i, masked);
        handled = true;
        break;
      }
    }

    if (handled) {
      continue;
    }

    if (measureStack.length > 0 && SOURCE_ASSIGNMENT.test(masked)) {
      measureStack[measureStack.length - 1].hasSource = true;
    }
  }

  for (const frame of blockStack) {
    diagnostics.push(
      error(
        lineRange(lines, frame.line),
        `Unclosed '${BLOCK_OPEN_KEYWORD[frame.kind]}' block: missing '${BLOCK_CLOSE_KEYWORD[frame.kind]}'.`
      )
    );
  }

  return { diagnostics, lineSnapshots, foldingRanges };
}
