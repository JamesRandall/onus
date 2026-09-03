/**
 * Structured diagnostics (language spec §13; impl spec §3.6).
 *
 * Every user-facing error is a `Diagnostic`. There are no warnings. Text and
 * JSON renderings are views over the object; nothing else ever prints an
 * error to the user.
 */
import { CODES, type Code } from './codes.js';
import { lineColOf, type FileId, type SourceFile, type Span } from '../source.js';

export type Confidence = 'high' | 'medium' | 'low';

export type Repair =
  | { readonly kind: 'replace'; readonly span: Span; readonly with: string; readonly confidence: Confidence }
  | { readonly kind: 'insert'; readonly after: number; readonly file: Span['file']; readonly text: string; readonly confidence: Confidence };

export type ObligationStatus = 'proved' | 'checked' | 'assumed' | 'failed' | 'unprovable';

export interface ObligationInfo {
  readonly kind: string;
  readonly text: string;
  readonly status: ObligationStatus;
  readonly counterexample: Readonly<Record<string, unknown>> | null;
}

export interface Diagnostic {
  readonly code: Code;
  readonly title: string;
  /** Innermost enclosing definition, or null when there is none (e.g. a syntax error in a header). */
  readonly def: string | null;
  readonly span: Span;
  readonly obligation: ObligationInfo | null;
  /** Human-readable detail lines. */
  readonly context: readonly string[];
  readonly repairs: readonly Repair[];
  readonly canonicalHash: string | null;
}

export interface DiagnosticInit {
  readonly code: Code;
  readonly span: Span;
  readonly def?: string | null;
  readonly obligation?: ObligationInfo;
  readonly context?: readonly string[];
  readonly repairs?: readonly Repair[];
  readonly canonicalHash?: string;
}

/**
 * Builds a Diagnostic, filling the title from the catalogue.
 * Effects: none.
 */
export function diagnostic(init: DiagnosticInit): Diagnostic {
  return {
    code: init.code,
    title: CODES[init.code],
    def: init.def ?? null,
    span: init.span,
    obligation: init.obligation ?? null,
    context: init.context ?? [],
    repairs: init.repairs ?? [],
    canonicalHash: init.canonicalHash ?? null,
  };
}

/**
 * Accumulates diagnostics. Passes never throw on user errors; they report here.
 * Effects: `report` appends to the internal list.
 */
export class DiagnosticSink {
  private readonly items: Diagnostic[] = [];

  report(d: Diagnostic): void {
    this.items.push(d);
  }

  /** All diagnostics reported so far, in report order. */
  all(): readonly Diagnostic[] {
    return this.items;
  }

  get count(): number {
    return this.items.length;
  }

  hasErrors(): boolean {
    return this.items.length > 0;
  }
}

export type JsonPos = readonly [number, number];
export type JsonSpan = readonly [JsonPos, JsonPos];

export interface DiagnosticJson {
  readonly code: Code;
  readonly title: string;
  readonly location: { readonly file: string; readonly def: string | null; readonly span: JsonSpan };
  readonly obligation?: ObligationInfo;
  readonly context: readonly string[];
  readonly repairs: readonly RepairJson[];
  readonly canonical_hash?: string;
}

export type RepairJson =
  | { readonly kind: 'replace'; readonly span: JsonSpan; readonly with: string; readonly confidence: Confidence }
  | { readonly kind: 'insert'; readonly after: JsonPos; readonly text: string; readonly confidence: Confidence };

export interface FileLookup {
  fileOf(span: Span): SourceFile;
  /** The `b3:` hash of the file's canonical text, or null when it has none (a syntax error). */
  canonicalHashOf(file: FileId): string | null;
}

function jsonSpan(files: FileLookup, s: Span): JsonSpan {
  const f = files.fileOf(s);
  const a = lineColOf(f, s.start);
  const b = lineColOf(f, s.end);
  return [
    [a.line, a.col],
    [b.line, b.col],
  ];
}

/**
 * Renders a diagnostic as the §13 JSON object.
 * Effects: none.
 */
export function toJson(files: FileLookup, d: Diagnostic): DiagnosticJson {
  const repairs: RepairJson[] = d.repairs.map((r) => {
    if (r.kind === 'replace') {
      return { kind: 'replace', span: jsonSpan(files, r.span), with: r.with, confidence: r.confidence };
    }
    const f = files.fileOf({ file: r.file, start: r.after, end: r.after });
    const p = lineColOf(f, r.after);
    return { kind: 'insert', after: [p.line, p.col], text: r.text, confidence: r.confidence };
  });
  const base: DiagnosticJson = {
    code: d.code,
    title: d.title,
    location: { file: files.fileOf(d.span).path, def: d.def, span: jsonSpan(files, d.span) },
    context: d.context,
    repairs,
  };
  const withObligation = d.obligation ? { ...base, obligation: d.obligation } : base;
  const hash = d.canonicalHash ?? files.canonicalHashOf(d.span.file);
  return hash !== null ? { ...withObligation, canonical_hash: hash } : withObligation;
}

/**
 * Renders a diagnostic as text for a terminal:
 *
 *   path:line:col: E0003 unexpected token
 *     expected `)`, found newline
 *
 * Effects: none.
 */
export function toText(files: FileLookup, d: Diagnostic): string {
  const f = files.fileOf(d.span);
  const p = lineColOf(f, d.span.start);
  const head = `${f.path}:${p.line}:${p.col}: ${d.code} ${d.title}`;
  const lines = [head];
  if (d.def) lines.push(`  in ${d.def}`);
  for (const c of d.context) lines.push(`  ${c}`);
  if (d.obligation) lines.push(`  obligation ${d.obligation.kind}: ${d.obligation.text} [${d.obligation.status}]`);
  for (const r of d.repairs) {
    if (r.kind === 'replace' && r.span.start === 0 && r.span.end === f.text.length) {
      lines.push(`  repair: replace the file with its canonical form (onus fmt)`);
    } else if (r.kind === 'replace') {
      lines.push(`  repair (${r.confidence}): replace with \`${r.with}\``);
    } else {
      lines.push(`  repair (${r.confidence}): insert \`${r.text}\``);
    }
  }
  return lines.join('\n');
}
