/**
 * The compilation context (impl spec §4). Passes are pure over it: each pass
 * reads the tables of earlier passes and writes only its own.
 */
import { readFileSync } from 'node:fs';
import { ConstTables } from './consteval/tables.js';
import { ContractTables } from './contracts/obligations.js';
import { EffectTables } from './effects/tables.js';
import { DiagnosticSink, type FileLookup } from './report/diagnostic.js';
import { ResolveTables } from './resolve/defs.js';
import { fileId, makeSourceFile, type FileId, type SourceFile, type Span } from './source.js';
import type { ParseResult } from './syntax/parser.js';
import { TypeTables } from './types/tables.js';

export interface VerifyOptions {
  /** Per-obligation solver budget in milliseconds (§12.3). */
  readonly budgetMs: number;
  /** Directory of the proof cache, or null to disable caching. */
  readonly cacheDir: string | null;
  /** Explicit z3 executable; null searches PATH. */
  readonly z3Path: string | null;
}

export interface ContextOptions {
  /** Project root that module names are resolved against; inferred from the first entry file when null. */
  readonly root: string | null;
  /** Directory containing `std/`; null disables the standard library and the prelude. */
  readonly stdlib: string | null;
  /** File access for the loader; returns null when the file does not exist. */
  readonly readFile: (path: string) => string | null;
  readonly verify: VerifyOptions;
  /** Informational output that is not a diagnostic (e.g. "z3 not found"). */
  readonly log: (line: string) => void;
}

/** Reads a file from disk, or null if it cannot be read. Effects: reads the file system. */
export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export class Context implements FileLookup {
  readonly options: ContextOptions;
  readonly files: SourceFile[] = [];
  readonly sink = new DiagnosticSink();
  /** Pass 1 output, per file. */
  readonly parsed = new Map<FileId, ParseResult>();
  /** Pass 2 output: the canonical text of each successfully parsed file. */
  readonly canonical = new Map<FileId, string>();
  /** Pass 3 output. */
  readonly resolve = new ResolveTables();
  /** Pass 4 output. */
  readonly types = new TypeTables();
  /** Pass 5 output. */
  readonly consteval = new ConstTables();
  /** Pass 6 output. */
  readonly effects = new EffectTables();
  /** Pass 8 output. */
  readonly contracts = new ContractTables();
  /** Next node id to assign; node ids are unique across all files of a compilation. */
  nextNodeId = 0;

  constructor(options: Partial<ContextOptions> = {}) {
    this.options = {
      root: options.root ?? null,
      stdlib: options.stdlib ?? null,
      readFile: options.readFile ?? readFileOrNull,
      verify: options.verify ?? { budgetMs: 500, cacheDir: null, z3Path: null },
      log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    };
  }

  /** Emits an informational line through the configured logger. Effects: those of the logger. */
  log(line: string): void {
    this.options.log(line);
  }

  /**
   * Registers a source file.
   * Postconditions: the returned file's id indexes `files`.
   * Effects: appends to `files`.
   */
  addFile(path: string, text: string): SourceFile {
    const f = makeSourceFile(fileId(this.files.length), path, text);
    this.files.push(f);
    return f;
  }

  fileOf(span: Span): SourceFile {
    const f = this.files[span.file];
    if (f === undefined) throw new Error(`unknown file id ${span.file}`);
    return f;
  }
}
