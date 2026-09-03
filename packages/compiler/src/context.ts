/**
 * The compilation context (impl spec §4). Passes are pure over it: each pass
 * reads the tables of earlier passes and writes only its own.
 */
import { DiagnosticSink, type FileLookup } from './report/diagnostic.js';
import { fileId, makeSourceFile, type FileId, type SourceFile, type Span } from './source.js';
import type { ParseResult } from './syntax/parser.js';

export class Context implements FileLookup {
  readonly files: SourceFile[] = [];
  readonly sink = new DiagnosticSink();
  /** Pass 1 output, per file. */
  readonly parsed = new Map<FileId, ParseResult>();
  /** Pass 2 output: the canonical text of each successfully parsed file. */
  readonly canonical = new Map<FileId, string>();

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
