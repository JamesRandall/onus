/**
 * Hand-written recursive-descent parser for Onus (language spec §2.3; impl
 * spec §4 pass 1). The grammar as implemented, including the deviations from
 * the provisional EBNF, is recorded in docs/grammar-v0.md.
 *
 * Properties:
 *   - LL(1) over the lexer's token stream, with two bounded lookaheads: a
 *     `NAME ':'` label test in argument lists, and the `NAME { '.' NAME } '.' TNAME`
 *     scan that distinguishes a qualified type name from a field access;
 *   - recovers at statement and item boundaries so that every syntax error in
 *     a file is reported;
 *   - never throws on user input; syntax errors are diagnostics.
 *
 * Node ids are assigned in pre-order after the tree is built (`renumber`).
 */
import { lex } from '../lexer/lexer.js';
import { describeKind, isNameKind, type Token, type TokenKind } from '../lexer/tokens.js';
import { diagnostic, type DiagnosticSink } from '../report/diagnostic.js';
import { join as joinSpan, span as mkSpan, type SourceFile, type Span } from '../source.js';
import type * as A from './ast.js';
import { nodeId, renumber } from './ast.js';
import { attachComments, type CommentTable } from './comments.js';

export interface ParseResult {
  /** null when the module header could not be parsed. */
  readonly module: A.Module | null;
  readonly comments: CommentTable;
  /** One past the last node id assigned; the next file continues from here so ids are unique across a compilation. */
  readonly nextId: number;
}

/**
 * Parses `file`.
 * Postconditions: every syntax error in the file has been reported to `sink`;
 * if `module` is non-null its ids are `firstId .. nextId-1` in pre-order.
 * Effects: reports diagnostics to `sink`.
 */
export function parse(file: SourceFile, sink: DiagnosticSink, firstId = 0): ParseResult {
  const lexed = lex(file, sink);
  const p = new Parser(file, lexed.tokens, sink);
  const module = p.parseModule();
  if (module === null) return { module: null, comments: new Map(), nextId: firstId };
  const nextId = renumber(module, firstId);
  return { module, comments: attachComments(module, lexed.comments, file), nextId };
}

/** Internal control-flow signal; always accompanied by a reported diagnostic. */
class ParseError extends Error {
  constructor() {
    super('parse error');
  }
}

const ITEM_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'pub', 'sealed', 'fn', 'const', 'type', 'record', 'union', 'interface', 'impl', 'claim',
  'capability', 'path', 'policy', 'example', 'property',
]);

const CMP_OPS: ReadonlySet<TokenKind> = new Set<TokenKind>(['==', '!=', '<', '<=', '>', '>=']);
const ADD_OPS: ReadonlySet<TokenKind> = new Set<TokenKind>(['+', '-', '++']);
const MUL_OPS: ReadonlySet<TokenKind> = new Set<TokenKind>(['*', '/', '%']);

const PLACEHOLDER = nodeId(-1);

class Parser {
  private pos = 0;
  private currentDef: string | null = null;
  private isTestModule = false;
  /** True when the module header names `std.…`; only such modules may declare intrinsics. */
  private isStdModule = false;
  /** When true, `{` after a type name does not begin a record constructor (condition contexts). */
  private noBrace = false;
  /** When true, bare expression statements are assertions (example, property and law blocks). */
  private assertionBlock = false;

  constructor(
    private readonly file: SourceFile,
    private readonly tokens: readonly Token[],
    private readonly sink: DiagnosticSink,
  ) {}

  // -------------------------------------------------------------------------
  // Token access
  // -------------------------------------------------------------------------

  private peek(n = 0): Token {
    const t = this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
    if (t === undefined) throw new Error('token stream is empty');
    return t;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private atEof(): boolean {
    return this.at('eof');
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private prev(): Token {
    const t = this.tokens[this.pos - 1];
    return t ?? this.peek();
  }

  private accept(kind: TokenKind): Token | null {
    return this.at(kind) ? this.advance() : null;
  }

  private expect(kind: TokenKind): Token {
    if (this.at(kind)) return this.advance();
    return this.fail(describeKind(kind));
  }

  private fail(expected: string, at: Token = this.peek()): never {
    this.sink.report(
      diagnostic({
        code: 'E0003',
        span: at.span,
        def: this.currentDef,
        context: [`expected ${expected}, found ${describeKind(at.kind)}`],
      }),
    );
    throw new ParseError();
  }

  private report(code: 'E0002' | 'E0006' | 'E0007' | 'E0011' | 'E0012' | 'E0102', span: Span, detail: string): void {
    this.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail] }));
  }

  private spanFrom(start: number): Span {
    return mkSpan(this.file.id, start, this.prev().span.end);
  }

  private here(): number {
    return this.peek().span.start;
  }

  /** Skips forward to the next newline, `}` or end of file (statement recovery). */
  private recoverToLineEnd(): void {
    while (!this.atEof() && !this.at('nl') && !this.at('}')) this.advance();
  }

  /** Skips forward to a newline followed by an item keyword (item recovery). */
  private recoverToItem(): void {
    while (!this.atEof()) {
      if (this.at('nl') && ITEM_START.has(this.peek(1).kind)) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  /** After an item or statement: a newline is required unless one was just consumed or a closer follows. */
  private terminator(): void {
    if (this.at('}') || this.atEof()) return;
    if (this.prev().kind === 'nl') return;
    this.expect('nl');
  }

  private withoutBrace<T>(f: () => T): T {
    const saved = this.noBrace;
    this.noBrace = true;
    try {
      return f();
    } finally {
      this.noBrace = saved;
    }
  }

  private withBrace<T>(f: () => T): T {
    const saved = this.noBrace;
    this.noBrace = false;
    try {
      return f();
    } finally {
      this.noBrace = saved;
    }
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  private ident(t: Token): A.Ident {
    return { text: t.text, span: t.span };
  }

  /** True iff the current token can serve as a name (a `name` token or a soft keyword). */
  private atName(n = 0): boolean {
    return isNameKind(this.peek(n).kind);
  }

  private name(): A.Ident {
    if (this.atName()) return this.ident(this.advance());
    return this.fail('a name');
  }

  private tname(): A.Ident {
    return this.ident(this.expect('tname'));
  }

  private qname(segments: A.Ident[]): A.QName {
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (first === undefined || last === undefined) throw new Error('empty qualified name');
    return { segments, span: joinSpan(first.span, last.span) };
  }

  /** `NAME { "." NAME }` — a module name. */
  private moduleName(): A.QName {
    const segs = [this.name()];
    while (this.at('.') && this.atName(1)) {
      this.advance();
      segs.push(this.name());
    }
    return this.qname(segs);
  }

  /** `( NAME | TNAME ) { "." ( NAME | TNAME ) }` — effects and claims. */
  private dotted(): A.QName {
    const segs: A.Ident[] = [];
    if (this.atName() || this.at('tname')) segs.push(this.ident(this.advance()));
    else this.fail('a name');
    while (this.at('.') && (this.atName(1) || this.peek(1).kind === 'tname')) {
      this.advance();
      segs.push(this.ident(this.advance()));
    }
    return this.qname(segs);
  }

  /** True iff the tokens ahead form `NAME { "." NAME } "." TNAME` or `TNAME`. */
  private qtnameAhead(): boolean {
    if (this.at('tname')) return true;
    if (!this.atName()) return false;
    let i = 1;
    while (this.peek(i).kind === '.') {
      const k = this.peek(i + 1).kind;
      if (k === 'tname') return true;
      if (!isNameKind(k)) return false;
      i += 2;
    }
    return false;
  }

  /** `{ NAME "." } TNAME` — a qualified type name. */
  private qtname(): A.QName {
    const segs: A.Ident[] = [];
    while (this.atName()) {
      segs.push(this.name());
      this.expect('.');
    }
    segs.push(this.tname());
    return this.qname(segs);
  }

  // -------------------------------------------------------------------------
  // Module
  // -------------------------------------------------------------------------

  parseModule(): A.Module | null {
    let test = false;
    try {
      if (this.accept('test')) test = true;
      this.isTestModule = test;
      this.expect('module');
      const name = this.moduleName();
      this.isStdModule = name.segments[0]?.text === 'std';
      this.expect('nl');
      const imports: A.Import[] = [];
      while (this.at('import')) {
        const s = this.here();
        this.advance();
        const n = this.moduleName();
        this.expect('nl');
        imports.push({ id: PLACEHOLDER, kind: 'Import', span: this.spanFrom(s), name: n });
      }
      const items: A.Item[] = [];
      while (!this.atEof()) {
        const before = this.pos;
        try {
          items.push(this.parseItem());
          this.terminator();
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          if (this.pos === before) this.advance();
          this.recoverToItem();
        }
        this.currentDef = null;
      }
      return {
        id: PLACEHOLDER,
        kind: 'Module',
        span: mkSpan(this.file.id, 0, this.file.text.length),
        test,
        name,
        imports,
        items,
      };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private visibility(): A.Visibility {
    const pub = this.accept('pub') !== null;
    const sealed = this.accept('sealed') !== null;
    return { pub, sealed };
  }

  private parseItem(): A.Item {
    const start = this.here();
    const t = this.peek();
    switch (t.kind) {
      case 'impl':
        return this.parseImpl(start);
      case 'path':
        return this.parsePath(start);
      case 'policy':
        return this.parsePolicy(start);
      case 'example':
        return this.parseExample(start);
      case 'property':
        return this.parseProperty(start);
      default:
        break;
    }
    const vis = this.visibility();
    switch (this.peek().kind) {
      case 'fn':
        return this.parseFn(start, vis, false, false);
      case 'const':
        if (this.peek(1).kind === 'fn') {
          this.advance();
          return this.parseFn(start, vis, true, false);
        }
        if (this.peek(1).kind === 'intrinsic' && this.peek(2).kind === 'fn') {
          this.advance();
          this.advance();
          return this.parseFn(start, vis, true, true);
        }
        return this.parseConst(start, vis);
      case 'intrinsic':
        if (this.peek(1).kind === 'fn') {
          this.advance();
          return this.parseFn(start, vis, false, true);
        }
        if (this.peek(1).kind === 'type') {
          this.advance();
          return this.parseIntrinsicType(start, vis);
        }
        this.advance();
        return this.fail('`fn` or `type` after `intrinsic`');
      case 'type':
        return this.parseTypeAlias(start, vis);
      case 'record':
        return this.parseRecord(start, vis);
      case 'union':
        return this.parseUnion(start, vis);
      case 'interface':
        return this.parseInterface(start, vis);
      case 'claim':
        return this.parseClaim(start, vis);
      case 'capability':
        return this.parseCapability(start, vis);
      default:
        return this.fail('an item (fn, type, const, record, union, interface, impl, claim, capability, path, policy, example or property)');
    }
  }

  private parseFn(start: number, vis: A.Visibility, constFn: boolean, intrinsic: boolean): A.FnDecl {
    const fnTok = this.expect('fn');
    const name = this.name();
    this.currentDef = name.text;
    if (intrinsic && !this.isStdModule) {
      this.report('E0102', joinSpan(fnTok.span, name.span), 'intrinsic declarations are reserved for `module std.…`');
    }
    const tparams = this.at('[') ? this.tparams() : [];
    const params = this.paramList();
    this.expect('->');
    const ret = this.withoutBrace(() => this.parseType());
    const effects = this.effectsOpt();
    const claims: A.QName[] = [];
    if (this.accept('claims')) {
      claims.push(this.dotted());
      while (this.accept(',')) claims.push(this.dotted());
    }
    const contracts = this.contracts();
    let body: A.Block | null = null;
    if (intrinsic) {
      if (this.at('{')) this.fail('a newline: an intrinsic function has no body');
    } else {
      body = this.parseBlock(true);
    }
    return { id: PLACEHOLDER, kind: 'FnDecl', span: this.spanFrom(start), vis, constFn, intrinsic, name, tparams, params, ret, effects, claims, contracts, body };
  }

  private parseIntrinsicType(start: number, vis: A.Visibility): A.IntrinsicType {
    const typeTok = this.expect('type');
    const name = this.tname();
    this.currentDef = name.text;
    if (!this.isStdModule) {
      this.report('E0102', joinSpan(typeTok.span, name.span), 'intrinsic declarations are reserved for `module std.…`');
    }
    const tparams = this.at('[') ? this.tparams() : [];
    return { id: PLACEHOLDER, kind: 'IntrinsicType', span: this.spanFrom(start), vis, name, tparams };
  }

  private contracts(): A.Contract[] {
    const out: A.Contract[] = [];
    while (this.at('requires') || this.at('ensures') || this.at('decreases')) {
      const s = this.here();
      const kw = this.advance().kind;
      const clause = kw === 'requires' ? 'requires' : kw === 'ensures' ? 'ensures' : 'decreases';
      const proved = clause !== 'decreases' && this.accept('proved') !== null;
      const expr = this.withoutBrace(() => this.parseExpr());
      out.push({ id: PLACEHOLDER, kind: 'Contract', span: this.spanFrom(s), clause, proved, expr });
    }
    return out;
  }

  private effectsOpt(): A.EffectRef[] {
    if (!this.accept('!')) return [];
    return this.effectList();
  }

  /**
   * `effect { "," effect }`. A comma continues the list only when an effect
   * follows: inside a parameter list `fn(T) -> U ! e, xs: List[T]` the comma
   * before `xs:` belongs to the parameters.
   */
  private effectList(): A.EffectRef[] {
    const out: A.EffectRef[] = [this.effectRef()];
    while (this.at(',') && this.effectFollows(1)) {
      this.advance();
      out.push(this.effectRef());
    }
    return out;
  }

  private effectFollows(n: number): boolean {
    const k = this.peek(n).kind;
    return (isNameKind(k) || k === 'recover') && this.peek(n + 1).kind !== ':';
  }

  /** `NAME { "." NAME }` or `recover`: effects are lowercase; claims never appear here. */
  private effectRef(): A.EffectRef {
    const s = this.here();
    // `recover` is a keyword but also names the effect a path may forbid (§10.2).
    const name = this.at('recover') ? this.qname([this.ident(this.advance())]) : this.moduleName();
    return { id: PLACEHOLDER, kind: 'EffectRef', span: this.spanFrom(s), name };
  }

  private tparams(): A.TParam[] {
    this.expect('[');
    const out: A.TParam[] = [];
    do {
      const s = this.here();
      if (this.at('tname')) {
        const name = this.tname();
        const bound = this.accept(':') ? this.tname() : null;
        out.push({ id: PLACEHOLDER, kind: 'TypeParam', span: this.spanFrom(s), name, bound });
      } else if (this.accept('const')) {
        const name = this.name();
        this.expect(':');
        const type = this.parseType();
        out.push({ id: PLACEHOLDER, kind: 'ConstParam', span: this.spanFrom(s), name, type });
      } else if (this.atName()) {
        const name = this.name();
        out.push({ id: PLACEHOLDER, kind: 'EffectParam', span: this.spanFrom(s), name });
      } else {
        this.fail('a type parameter, `const` parameter or effect parameter');
      }
    } while (this.accept(','));
    this.expect(']');
    return out;
  }

  private paramList(): A.Param[] {
    this.expect('(');
    const out: A.Param[] = [];
    if (!this.at(')')) {
      do {
        out.push(this.param());
      } while (this.accept(','));
    }
    this.expect(')');
    return out;
  }

  private param(): A.Param {
    const s = this.here();
    const name = this.name();
    this.expect(':');
    const inout = this.accept('inout') !== null;
    const type = this.withBrace(() => this.parseType());
    return { id: PLACEHOLDER, kind: 'Param', span: this.spanFrom(s), inout, name, type };
  }

  private parseConst(start: number, vis: A.Visibility): A.ConstDecl {
    this.expect('const');
    const name = this.name();
    this.currentDef = name.text;
    this.expect(':');
    const type = this.parseType();
    this.expect('=');
    const value = this.parseExpr();
    return { id: PLACEHOLDER, kind: 'ConstDecl', span: this.spanFrom(start), vis, name, type, value };
  }

  private parseTypeAlias(start: number, vis: A.Visibility): A.TypeAlias {
    this.expect('type');
    const name = this.tname();
    this.currentDef = name.text;
    this.expect('=');
    const type = this.parseType();
    return { id: PLACEHOLDER, kind: 'TypeAlias', span: this.spanFrom(start), vis, name, type };
  }

  private parseRecord(start: number, vis: A.Visibility): A.RecordDecl {
    this.expect('record');
    const name = this.tname();
    this.currentDef = name.text;
    const tparams = this.at('[') ? this.tparams() : [];
    const fields = this.braced(() => this.field());
    return { id: PLACEHOLDER, kind: 'RecordDecl', span: this.spanFrom(start), vis, name, tparams, fields };
  }

  private field(): A.Field {
    const s = this.here();
    const name = this.name();
    this.expect(':');
    const type = this.parseType();
    return { id: PLACEHOLDER, kind: 'Field', span: this.spanFrom(s), name, type };
  }

  private parseUnion(start: number, vis: A.Visibility): A.UnionDecl {
    this.expect('union');
    const name = this.tname();
    this.currentDef = name.text;
    const tparams = this.at('[') ? this.tparams() : [];
    this.expect('=');
    this.expect('nl');
    const variants: A.Variant[] = [];
    while (this.at('|')) {
      const s = this.here();
      this.advance();
      const vname = this.tname();
      const fields: A.Field[] = [];
      if (this.accept('of')) {
        fields.push(this.field());
        while (this.accept(',')) fields.push(this.field());
      }
      variants.push({ id: PLACEHOLDER, kind: 'Variant', span: this.spanFrom(s), name: vname, fields });
      this.expect('nl');
    }
    const end = variants.length > 0 ? (variants[variants.length - 1]?.span.end ?? start) : this.prev().span.end;
    return { id: PLACEHOLDER, kind: 'UnionDecl', span: mkSpan(this.file.id, start, end), vis, name, tparams, variants };
  }

  private parseInterface(start: number, vis: A.Visibility): A.InterfaceDecl {
    this.expect('interface');
    const name = this.tname();
    this.currentDef = name.text;
    this.expect('[');
    const tparam = this.tname();
    this.expect(']');
    const items = this.braced(() => this.ifaceItem());
    return { id: PLACEHOLDER, kind: 'InterfaceDecl', span: this.spanFrom(start), vis, name, tparam, items };
  }

  private ifaceItem(): A.IfaceItem {
    const s = this.here();
    if (this.accept('law')) {
      const name = this.name();
      const params = this.paramList();
      const body = this.parseAssertionBlock();
      return { id: PLACEHOLDER, kind: 'Law', span: this.spanFrom(s), name, params, body };
    }
    this.expect('fn');
    const name = this.name();
    const params = this.paramList();
    this.expect('->');
    const ret = this.withoutBrace(() => this.parseType());
    const effects = this.effectsOpt();
    const contracts = this.contracts();
    return { id: PLACEHOLDER, kind: 'IfaceFn', span: this.spanFrom(s), name, params, ret, effects, contracts };
  }

  private parseImpl(start: number): A.ImplDecl {
    this.expect('impl');
    const iface = this.tname();
    this.expect('[');
    const target = this.parseType();
    this.expect(']');
    this.currentDef = `${iface.text}[${this.file.text.slice(target.span.start, target.span.end)}]`;
    const fns = this.braced(() => {
      const s = this.here();
      const vis = this.visibility();
      return this.parseFn(s, vis, false, false);
    });
    return { id: PLACEHOLDER, kind: 'ImplDecl', span: this.spanFrom(start), iface, target, fns };
  }

  private parseClaim(start: number, vis: A.Visibility): A.ClaimDecl {
    this.expect('claim');
    const name = this.tname();
    this.currentDef = name.text;
    let body: A.ClaimBody;
    if (this.accept(':=')) {
      body = { kind: 'Derived', pred: this.claimOr() };
    } else if (this.at('text')) {
      body = { kind: 'Asserted', description: this.textValue(this.advance()) };
    } else {
      return this.fail('`:=` or a description text');
    }
    return { id: PLACEHOLDER, kind: 'ClaimDecl', span: this.spanFrom(start), vis, name, body };
  }

  private claimOr(): A.ClaimPred {
    const s = this.here();
    const first = this.claimAnd();
    if (!this.at('or')) return first.pred;
    const operands = [first.pred];
    let mixed = first.chained;
    while (this.accept('or')) {
      const next = this.claimAnd();
      mixed = mixed || next.chained;
      operands.push(next.pred);
    }
    const span = this.spanFrom(s);
    if (mixed) this.report('E0007', span, 'write `(a and b) or c` or `a and (b or c)`');
    return { id: PLACEHOLDER, kind: 'ClaimOr', span, operands };
  }

  private claimAnd(): { pred: A.ClaimPred; chained: boolean } {
    const s = this.here();
    const first = this.claimNot();
    if (!this.at('and')) return { pred: first, chained: false };
    const operands = [first];
    while (this.accept('and')) operands.push(this.claimNot());
    return { pred: { id: PLACEHOLDER, kind: 'ClaimAnd', span: this.spanFrom(s), operands }, chained: true };
  }

  private claimNot(): A.ClaimPred {
    const s = this.here();
    if (this.accept('not')) {
      const operand = this.claimAtom();
      return { id: PLACEHOLDER, kind: 'ClaimNot', span: this.spanFrom(s), operand };
    }
    return this.claimAtom();
  }

  private claimAtom(): A.ClaimPred {
    const s = this.here();
    if (this.accept('(')) {
      const inner = this.claimOr();
      this.expect(')');
      return inner;
    }
    if (this.accept('effects')) {
      this.expect('==');
      this.expect('{');
      const effects = this.at('}') ? [] : this.effectList();
      this.expect('}');
      return { id: PLACEHOLDER, kind: 'ClaimEffectsEq', span: this.spanFrom(s), effects };
    }
    if (this.atName() || this.at('tname')) {
      const name = this.dotted();
      return { id: PLACEHOLDER, kind: 'ClaimAtom', span: this.spanFrom(s), name };
    }
    return this.fail('an effect, a claim, `effects == { ... }` or `(`');
  }

  private parseCapability(start: number, vis: A.Visibility): A.CapabilityDecl {
    this.expect('capability');
    const name = this.tname();
    this.currentDef = name.text;
    const tparams = this.at('[') ? this.tparams() : [];
    this.expect('nl');
    const grants: A.Grant[] = [];
    while (this.at('grants')) {
      const s = this.here();
      this.advance();
      const effect = this.effectRef();
      const when = this.accept('when') ? this.withoutBrace(() => this.parseExpr()) : null;
      grants.push({ id: PLACEHOLDER, kind: 'Grant', span: this.spanFrom(s), effect, when });
      this.expect('nl');
    }
    const end = grants.length > 0 ? (grants[grants.length - 1]?.span.end ?? start) : name.span.end;
    return { id: PLACEHOLDER, kind: 'CapabilityDecl', span: mkSpan(this.file.id, start, end), vis, name, tparams, grants };
  }

  private parsePath(start: number): A.PathDecl {
    this.expect('path');
    const name = this.name();
    this.currentDef = name.text;
    this.expect('nl');
    this.expect('entry');
    const entry = this.name();
    this.expect('nl');
    const clauses: A.PathClause[] = [];
    for (;;) {
      const s = this.here();
      if (this.accept('effects')) {
        this.expect('<=');
        this.expect('{');
        const effects = this.at('}') ? [] : this.effectList();
        this.expect('}');
        clauses.push({ id: PLACEHOLDER, kind: 'PathEffects', span: this.spanFrom(s), effects });
      } else if (this.accept('forbid')) {
        this.expect('{');
        const effects = this.at('}') ? [] : this.effectList();
        this.expect('}');
        clauses.push({ id: PLACEHOLDER, kind: 'PathForbid', span: this.spanFrom(s), effects });
      } else if (this.accept('require')) {
        this.expect('{');
        const claims: A.QName[] = [];
        if (!this.at('}')) {
          claims.push(this.dotted());
          while (this.accept(',')) claims.push(this.dotted());
        }
        this.expect('}');
        clauses.push({ id: PLACEHOLDER, kind: 'PathRequire', span: this.spanFrom(s), claims });
      } else if (this.accept('policy')) {
        const pname = this.name();
        const except: A.QName[] = [];
        if (this.accept('except')) {
          this.expect('{');
          except.push(this.dotted());
          while (this.accept(',')) except.push(this.dotted());
          this.expect('}');
        }
        clauses.push({ id: PLACEHOLDER, kind: 'PathPolicy', span: this.spanFrom(s), name: pname, except });
      } else {
        break;
      }
      this.expect('nl');
    }
    const last = clauses[clauses.length - 1];
    const end = last !== undefined ? last.span.end : entry.span.end;
    return { id: PLACEHOLDER, kind: 'PathDecl', span: mkSpan(this.file.id, start, end), name, entry, clauses };
  }

  private parsePolicy(start: number): A.PolicyDecl {
    this.expect('policy');
    const name = this.name();
    this.currentDef = name.text;
    this.expect('nl');
    this.expect('forbid');
    this.expect('assume');
    this.expect('outside');
    this.expect('{');
    const outside: A.PolicyScope[] = [];
    do {
      const s = this.here();
      if (this.accept('self')) {
        outside.push({ id: PLACEHOLDER, kind: 'PolicyScope', span: this.spanFrom(s), name: null, glob: false });
      } else {
        const n = this.moduleName();
        let glob = false;
        if (this.at('.') && this.peek(1).kind === '*') {
          this.advance();
          this.advance();
          glob = true;
        }
        outside.push({ id: PLACEHOLDER, kind: 'PolicyScope', span: this.spanFrom(s), name: n, glob });
      }
    } while (this.accept(','));
    this.expect('}');
    return { id: PLACEHOLDER, kind: 'PolicyDecl', span: this.spanFrom(start), name, outside };
  }

  private parseExample(start: number): A.ExampleDecl {
    this.expect('example');
    const name = this.name();
    this.currentDef = name.text;
    const body = this.parseAssertionBlock();
    return { id: PLACEHOLDER, kind: 'ExampleDecl', span: this.spanFrom(start), name, body };
  }

  private parseProperty(start: number): A.PropertyDecl {
    this.expect('property');
    const name = this.name();
    this.currentDef = name.text;
    const params = this.paramList();
    const body = this.parseAssertionBlock();
    return { id: PLACEHOLDER, kind: 'PropertyDecl', span: this.spanFrom(start), name, params, body };
  }

  /**
   * `"{" ( NL { item NL } | [ item ] ) "}"` with statement-level recovery.
   */
  private braced<T>(item: () => T): T[] {
    this.expect('{');
    return this.bracedRest(item);
  }

  /**
   * A function body: a block, or `{ ... }` when `allowElided` (an interface
   * rendering, §11.1), which yields null.
   */
  private bracedOrElided<T>(item: () => T, allowElided: boolean): T[] | null {
    this.expect('{');
    if (allowElided && this.accept('...')) {
      this.expect('}');
      return null;
    }
    return this.bracedRest(item);
  }

  private bracedRest<T>(item: () => T): T[] {
    const out: T[] = [];
    if (this.accept('nl')) {
      while (!this.at('}') && !this.atEof()) {
        const before = this.pos;
        try {
          out.push(item());
          this.terminator();
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          if (this.pos === before) this.advance();
          this.recoverToLineEnd();
          this.accept('nl');
        }
      }
      this.expect('}');
      return out;
    }
    if (this.accept('}')) return out;
    out.push(item());
    this.expect('}');
    return out;
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private parseType(): A.Type {
    const s = this.here();
    if (this.accept('fn')) {
      const params = this.paramList();
      this.expect('->');
      const ret = this.parseType();
      const effects = this.effectsOpt();
      return { id: PLACEHOLDER, kind: 'FnType', span: this.spanFrom(s), params, ret, effects };
    }
    if (!this.qtnameAhead()) this.fail('a type');
    const name = this.qtname();
    const args = this.at('[') ? this.typeArgs() : [];
    const where = this.accept('where') ? this.parseExpr() : null;
    return { id: PLACEHOLDER, kind: 'NamedType', span: this.spanFrom(s), name, args, where };
  }

  /** The type of a quantified variable: no `where` clause, which belongs to the quantifier. */
  private parseBinderType(): A.Type {
    const s = this.here();
    if (this.at('fn')) return this.parseType();
    if (!this.qtnameAhead()) this.fail('a type');
    const name = this.qtname();
    const args = this.at('[') ? this.typeArgs() : [];
    return { id: PLACEHOLDER, kind: 'NamedType', span: this.spanFrom(s), name, args, where: null };
  }

  private typeArgs(): A.TypeArg[] {
    this.expect('[');
    const out: A.TypeArg[] = [];
    this.withBrace(() => {
      do {
        out.push(this.typeArg());
      } while (this.accept(','));
    });
    this.expect(']');
    return out;
  }

  private typeArg(): A.TypeArg {
    const s = this.here();
    let label: A.Ident | null = null;
    if (this.atName() && this.peek(1).kind === ':') {
      label = this.name();
      this.advance();
    }
    if (this.at('fn') || this.qtnameAhead()) {
      const type = this.parseType();
      return { id: PLACEHOLDER, kind: 'TypeArgType', span: this.spanFrom(s), label, type };
    }
    const expr = this.parseExpr();
    return { id: PLACEHOLDER, kind: 'TypeArgConst', span: this.spanFrom(s), label, expr };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private parseBlock(allowElided = false): A.Block {
    const s = this.here();
    const saved = this.assertionBlock;
    this.assertionBlock = false;
    try {
      const stmts = this.withBrace(() => this.bracedOrElided(() => this.parseStmt(), allowElided));
      return { id: PLACEHOLDER, kind: 'Block', span: this.spanFrom(s), stmts: stmts ?? [], elided: stmts === null };
    } finally {
      this.assertionBlock = saved;
    }
  }

  /** A block whose bare expression statements are assertions (§5.2). */
  private parseAssertionBlock(): A.Block {
    const s = this.here();
    const saved = this.assertionBlock;
    this.assertionBlock = true;
    try {
      const stmts = this.withBrace(() => this.braced(() => this.parseStmt()));
      return { id: PLACEHOLDER, kind: 'Block', span: this.spanFrom(s), stmts, elided: false };
    } finally {
      this.assertionBlock = saved;
    }
  }

  private parseStmt(): A.Stmt {
    const s = this.here();
    switch (this.peek().kind) {
      case 'let':
      case 'var': {
        const kind = this.advance().kind === 'let' ? 'Let' : 'Var';
        const name = this.name();
        this.expect(':');
        const type = this.parseType();
        this.expect('=');
        const value = this.parseExpr();
        return { id: PLACEHOLDER, kind, span: this.spanFrom(s), name, type, value };
      }
      case 'return': {
        this.advance();
        const value = this.parseExpr();
        return { id: PLACEHOLDER, kind: 'Return', span: this.spanFrom(s), value };
      }
      case 'if':
        return this.parseIf();
      case 'match': {
        this.advance();
        const scrutinee = this.withoutBrace(() => this.parseExpr());
        this.expect('with');
        this.expect('nl');
        const arms: A.Arm[] = [];
        while (this.at('|')) {
          const as = this.here();
          this.advance();
          const pattern = this.parsePattern();
          const guard = this.accept('when') ? this.parseExpr() : null;
          this.expect('->');
          const body: A.Stmt | A.Block = this.at('{') ? this.parseBlock() : this.parseStmt();
          arms.push({ id: PLACEHOLDER, kind: 'Arm', span: this.spanFrom(as), pattern, guard, body });
          this.terminator();
          if (this.at('}') || this.atEof()) break;
        }
        const lastArm = arms[arms.length - 1];
        const end = lastArm !== undefined ? lastArm.span.end : scrutinee.span.end;
        return { id: PLACEHOLDER, kind: 'Match', span: mkSpan(this.file.id, s, end), scrutinee, arms };
      }
      case 'loop': {
        this.advance();
        this.expect('while');
        const cond = this.withoutBrace(() => this.parseExpr());
        const clauses: A.LoopClause[] = [];
        while (this.at('invariant') || this.at('decreases')) {
          const cs = this.here();
          const clause = this.advance().kind === 'invariant' ? 'invariant' : 'decreases';
          const expr = this.withoutBrace(() => this.parseExpr());
          clauses.push({ id: PLACEHOLDER, kind: 'LoopClause', span: this.spanFrom(cs), clause, expr });
        }
        const body = this.parseBlock();
        return { id: PLACEHOLDER, kind: 'Loop', span: this.spanFrom(s), cond, clauses, body };
      }
      case 'for': {
        this.advance();
        const name = this.name();
        this.expect(':');
        const type = this.parseType();
        this.expect('in');
        const domain = this.withoutBrace(() => this.parseDomain());
        const body = this.parseBlock();
        return { id: PLACEHOLDER, kind: 'For', span: this.spanFrom(s), name, type, domain, body };
      }
      case 'assume': {
        this.advance();
        const claim = this.dotted();
        const justification = this.textValue(this.expect('text'));
        return { id: PLACEHOLDER, kind: 'Assume', span: this.spanFrom(s), claim, justification };
      }
      default: {
        const expr = this.parseExpr();
        if (expr.kind === 'Name' && this.accept('=')) {
          const value = this.parseExpr();
          return { id: PLACEHOLDER, kind: 'Assign', span: this.spanFrom(s), name: expr.name, value };
        }
        if (!this.assertionBlock && !isCallForEffect(expr)) {
          this.report('E0002', expr.span, 'a bare expression statement must be a call (or `try` of a call)');
        }
        return { id: PLACEHOLDER, kind: 'ExprStmt', span: this.spanFrom(s), expr };
      }
    }
  }

  private parseIf(): A.If {
    const s = this.here();
    this.expect('if');
    const cond = this.withoutBrace(() => this.parseExpr());
    const then = this.parseBlock();
    let elseBlock: A.Block | null = null;
    if (this.accept('else')) {
      if (this.at('if')) {
        const nested = this.parseIf();
        elseBlock = { id: PLACEHOLDER, kind: 'Block', span: nested.span, stmts: [nested], elided: false };
      } else {
        elseBlock = this.parseBlock();
      }
    }
    return { id: PLACEHOLDER, kind: 'If', span: this.spanFrom(s), cond, then, else: elseBlock };
  }

  private parseDomain(): A.Domain {
    const s = this.here();
    const first = this.parseExpr();
    if (this.accept('..<')) {
      const hi = this.parseExpr();
      return { id: PLACEHOLDER, kind: 'RangeDomain', span: this.spanFrom(s), lo: first, hi };
    }
    return { id: PLACEHOLDER, kind: 'InDomain', span: this.spanFrom(s), expr: first };
  }

  private textValue(t: Token): string {
    return typeof t.value === 'string' ? t.value : '';
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  parseExpr(): A.Expr {
    const s = this.here();
    const left = this.orExpr();
    if (!this.at('implies')) return left;
    this.advance();
    const right = this.orExpr();
    const span = this.spanFrom(s);
    if (this.at('implies')) {
      this.report('E0011', this.peek().span, 'parenthesise one side: `(a implies b) implies c` or `a implies (b implies c)`');
      this.advance();
      this.orExpr();
    }
    return { id: PLACEHOLDER, kind: 'Binary', span, op: 'implies', left, right };
  }

  private orExpr(): A.Expr {
    const s = this.here();
    const first = this.andExpr();
    if (!this.at('or')) return first.expr;
    const operands = [first.expr];
    let mixed = first.chained;
    while (this.accept('or')) {
      const next = this.andExpr();
      mixed = mixed || next.chained;
      operands.push(next.expr);
    }
    const span = this.spanFrom(s);
    if (mixed) this.report('E0007', span, 'write `(a and b) or c` or `a and (b or c)`');
    return { id: PLACEHOLDER, kind: 'Or', span, operands };
  }

  private andExpr(): { expr: A.Expr; chained: boolean } {
    const s = this.here();
    const first = this.notExpr();
    if (!this.at('and')) return { expr: first, chained: false };
    const operands = [first];
    while (this.accept('and')) operands.push(this.notExpr());
    return { expr: { id: PLACEHOLDER, kind: 'And', span: this.spanFrom(s), operands }, chained: true };
  }

  private notExpr(): A.Expr {
    const s = this.here();
    if (this.accept('not')) {
      const operand = this.cmpExpr();
      return { id: PLACEHOLDER, kind: 'Unary', span: this.spanFrom(s), op: 'not', operand };
    }
    return this.cmpExpr();
  }

  private cmpExpr(): A.Expr {
    const s = this.here();
    const left = this.addExpr();
    if (this.at('is')) {
      this.advance();
      const pattern = this.parsePattern();
      return { id: PLACEHOLDER, kind: 'Is', span: this.spanFrom(s), expr: left, pattern };
    }
    const opTok = this.peek();
    if (!CMP_OPS.has(opTok.kind)) return left;
    this.advance();
    const right = this.addExpr();
    const span = this.spanFrom(s);
    if (CMP_OPS.has(this.peek().kind)) {
      this.report('E0006', this.peek().span, 'write `a < b and b < c`');
      this.advance();
      this.addExpr();
    }
    return { id: PLACEHOLDER, kind: 'Binary', span, op: this.binaryOp(opTok.kind), left, right };
  }

  private binaryOp(kind: TokenKind): A.BinaryOp {
    switch (kind) {
      case '*':
      case '/':
      case '%':
      case '+':
      case '-':
      case '++':
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return kind;
      default:
        throw new Error(`not a binary operator: ${kind}`);
    }
  }

  private addExpr(): A.Expr {
    const s = this.here();
    let left = this.mulExpr();
    while (ADD_OPS.has(this.peek().kind)) {
      const op = this.binaryOp(this.advance().kind);
      const right = this.mulExpr();
      left = { id: PLACEHOLDER, kind: 'Binary', span: this.spanFrom(s), op, left, right };
    }
    return left;
  }

  private mulExpr(): A.Expr {
    const s = this.here();
    let left = this.unaryExpr();
    while (MUL_OPS.has(this.peek().kind)) {
      const op = this.binaryOp(this.advance().kind);
      const right = this.unaryExpr();
      left = { id: PLACEHOLDER, kind: 'Binary', span: this.spanFrom(s), op, left, right };
    }
    return left;
  }

  private unaryExpr(): A.Expr {
    const s = this.here();
    if (this.accept('-')) {
      const operand = this.postfixExpr();
      return { id: PLACEHOLDER, kind: 'Unary', span: this.spanFrom(s), op: 'neg', operand };
    }
    return this.postfixExpr();
  }

  private postfixExpr(): A.Expr {
    const s = this.here();
    let e = this.primary();
    for (;;) {
      if (this.at('.')) {
        const nextKind = this.peek(1).kind;
        if (isNameKind(nextKind)) {
          this.advance();
          const name = this.name();
          e = { id: PLACEHOLDER, kind: 'FieldAccess', span: this.spanFrom(s), object: e, name };
          continue;
        }
        if (nextKind === 'tname') {
          const prefix = nameChain(e);
          if (prefix === null) this.fail('a field name after `.`', this.peek(1));
          this.advance();
          prefix.push(this.tname());
          e = this.ctorRest(s, this.qname(prefix));
          continue;
        }
        this.advance();
        this.fail('a field name after `.`');
      }
      if (this.at('[')) {
        const targs = this.typeArgs();
        const args = this.callArgs();
        e = { id: PLACEHOLDER, kind: 'Call', span: this.spanFrom(s), callee: e, targs, args };
        continue;
      }
      if (this.at('(')) {
        const args = this.callArgs();
        e = { id: PLACEHOLDER, kind: 'Call', span: this.spanFrom(s), callee: e, targs: null, args };
        continue;
      }
      return e;
    }
  }

  private callArgs(): A.Arg[] {
    this.expect('(');
    const out: A.Arg[] = [];
    this.withBrace(() => {
      if (!this.at(')')) {
        do {
          const s = this.here();
          const name = this.name();
          this.expect(':');
          const inout = this.accept('inout') !== null;
          const value = this.parseExpr();
          out.push({ id: PLACEHOLDER, kind: 'Arg', span: this.spanFrom(s), name, inout, value });
        } while (this.accept(','));
      }
    });
    this.expect(')');
    return out;
  }

  /** `[ call_args ] [ "{" field_inits "}" ]` after a qualified type name. */
  private ctorRest(start: number, name: A.QName): A.Ctor {
    const args = this.at('(') ? this.callArgs() : null;
    const fields = !this.noBrace && this.at('{') ? this.fieldInits() : null;
    return { id: PLACEHOLDER, kind: 'Ctor', span: this.spanFrom(start), name, args, fields };
  }

  /** `"{" [ NL ] [ field_init { "," [ NL ] field_init } ] [ NL ] "}"` */
  private fieldInits(): A.FieldInit[] {
    this.expect('{');
    const out: A.FieldInit[] = [];
    this.withBrace(() => {
      this.accept('nl');
      if (!this.at('}')) {
        do {
          this.accept('nl');
          const s = this.here();
          const name = this.name();
          this.expect(':');
          const value = this.parseExpr();
          out.push({ id: PLACEHOLDER, kind: 'FieldInit', span: this.spanFrom(s), name, value });
        } while (this.accept(','));
        this.accept('nl');
      }
    });
    this.expect('}');
    return out;
  }

  private primary(): A.Expr {
    const s = this.here();
    const t = this.peek();
    switch (t.kind) {
      case 'int': {
        this.advance();
        return { id: PLACEHOLDER, kind: 'IntLit', span: t.span, value: typeof t.value === 'bigint' ? t.value : 0n };
      }
      case 'float': {
        this.advance();
        return { id: PLACEHOLDER, kind: 'FloatLit', span: t.span, value: typeof t.value === 'number' ? t.value : 0 };
      }
      case 'text': {
        this.advance();
        return { id: PLACEHOLDER, kind: 'TextLit', span: t.span, value: this.textValue(t) };
      }
      case 'duration': {
        this.advance();
        return { id: PLACEHOLDER, kind: 'DurationLit', span: t.span, nanos: typeof t.value === 'bigint' ? t.value : 0n };
      }
      case 'true':
      case 'false': {
        this.advance();
        return { id: PLACEHOLDER, kind: 'BoolLit', span: t.span, value: t.kind === 'true' };
      }
      case 'it':
        this.advance();
        return { id: PLACEHOLDER, kind: 'It', span: t.span };
      case 'result':
        this.advance();
        return { id: PLACEHOLDER, kind: 'ResultRef', span: t.span };
      case 'tname': {
        const name = this.qname([this.tname()]);
        return this.ctorRest(s, name);
      }
      case '{': {
        if (this.noBrace) this.fail('an expression (parenthesise a record update in this position)');
        this.advance();
        const base = this.withBrace(() => this.parseExpr());
        this.expect('with');
        const fields: A.FieldInit[] = [];
        this.withBrace(() => {
          do {
            this.accept('nl');
            const fs = this.here();
            const fname = this.name();
            this.expect(':');
            const value = this.parseExpr();
            fields.push({ id: PLACEHOLDER, kind: 'FieldInit', span: this.spanFrom(fs), name: fname, value });
          } while (this.accept(','));
          this.accept('nl');
        });
        this.expect('}');
        return { id: PLACEHOLDER, kind: 'RecordUpdate', span: this.spanFrom(s), base, fields };
      }
      case '(': {
        this.advance();
        const inner = this.withBrace(() => this.parseExpr());
        this.expect(')');
        return inner;
      }
      case '[': {
        this.advance();
        const elems: A.Expr[] = [];
        this.withBrace(() => {
          if (!this.at(']')) {
            do {
              elems.push(this.parseExpr());
            } while (this.accept(','));
          }
        });
        this.expect(']');
        return { id: PLACEHOLDER, kind: 'ListLit', span: this.spanFrom(s), elems };
      }
      case 'try': {
        this.advance();
        const expr = this.parseExpr();
        let elseClause: A.TryElse | null = null;
        if (this.at('else')) {
          const es = this.here();
          this.advance();
          const name = this.name();
          this.expect(':');
          const eexpr = this.parseExpr();
          elseClause = { id: PLACEHOLDER, kind: 'TryElse', span: this.spanFrom(es), name, expr: eexpr };
        }
        return { id: PLACEHOLDER, kind: 'Try', span: this.spanFrom(s), expr, else: elseClause };
      }
      case 'recover': {
        // The block's final expression is its value (§10.2), so bare expressions are allowed.
        this.advance();
        const body = this.parseAssertionBlock();
        return { id: PLACEHOLDER, kind: 'Recover', span: this.spanFrom(s), body };
      }
      case 'old': {
        this.advance();
        this.expect('(');
        const name = this.name();
        this.expect(')');
        return { id: PLACEHOLDER, kind: 'Old', span: this.spanFrom(s), name };
      }
      case 'forall':
      case 'exists': {
        this.advance();
        const quant = t.kind;
        const name = this.name();
        this.expect(':');
        const type = this.parseBinderType();
        const domain = this.accept('in') ? this.parseDomain() : null;
        const where = this.accept('where') ? this.parseExpr() : null;
        this.expect(':');
        const body = this.parseExpr();
        return { id: PLACEHOLDER, kind: 'Quantifier', span: this.spanFrom(s), quant, name, type, domain, where, body };
      }
      case 'fn': {
        this.advance();
        const params = this.paramList();
        this.expect('->');
        const ret = this.withoutBrace(() => this.parseType());
        const effects = this.effectsOpt();
        const body = this.parseBlock();
        return { id: PLACEHOLDER, kind: 'Closure', span: this.spanFrom(s), params, ret, effects, body };
      }
      case 'fake': {
        this.advance();
        if (!this.isTestModule) this.report('E0012', t.span, '`fake` constructs capabilities only inside a `test module`');
        const capability = this.qtname();
        const fields = this.fieldInits();
        return { id: PLACEHOLDER, kind: 'Fake', span: this.spanFrom(s), capability, fields };
      }
      default: {
        if (this.atName()) {
          const name = this.name();
          return { id: PLACEHOLDER, kind: 'Name', span: name.span, name };
        }
        return this.fail('an expression');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  private parsePattern(): A.Pattern {
    const s = this.here();
    const t = this.peek();
    switch (t.kind) {
      case '_':
        this.advance();
        return { id: PLACEHOLDER, kind: 'WildcardPat', span: t.span };
      case 'int':
      case 'float':
      case 'text':
      case 'duration':
      case 'true':
      case 'false':
      case '-': {
        const lit = this.unaryExpr();
        if (!isLiteral(lit)) return this.fail('a literal pattern', t);
        return { id: PLACEHOLDER, kind: 'LitPat', span: this.spanFrom(s), literal: lit };
      }
      case 'tname':
        return this.variantPattern(s);
      default: {
        if (this.atName()) {
          if (!this.qtnameAhead()) {
            const name = this.name();
            return { id: PLACEHOLDER, kind: 'BindPat', span: name.span, name };
          }
          return this.variantPattern(s);
        }
        return this.fail('a pattern');
      }
    }
  }

  private variantPattern(start: number): A.VariantPat {
    const name = this.qtname();
    let fields: A.PatField[] | null = null;
    if (this.accept('(')) {
      fields = [];
      do {
        const fs = this.here();
        if (this.accept('_')) fields.push({ id: PLACEHOLDER, kind: 'PatFieldSkip', span: this.spanFrom(fs) });
        else if (this.accept('..')) fields.push({ id: PLACEHOLDER, kind: 'PatFieldRest', span: this.spanFrom(fs) });
        else {
          const n = this.name();
          fields.push({ id: PLACEHOLDER, kind: 'PatFieldName', span: n.span, name: n });
        }
      } while (this.accept(','));
      this.expect(')');
    }
    return { id: PLACEHOLDER, kind: 'VariantPat', span: this.spanFrom(start), name, fields };
  }
}

/** True iff `e` is a call, or a `try` whose operand is one (§2.3: a bare expression statement must be a call). */
function isCallForEffect(e: A.Expr): boolean {
  if (e.kind === 'Call') return true;
  if (e.kind === 'Try') return isCallForEffect(e.expr);
  return false;
}

/** If `e` is `a.b.c` over a plain name, its segments; else null. */
function nameChain(e: A.Expr): A.Ident[] | null {
  if (e.kind === 'Name') return [e.name];
  if (e.kind === 'FieldAccess') {
    const head = nameChain(e.object);
    if (head === null) return null;
    head.push(e.name);
    return head;
  }
  return null;
}

function isLiteral(e: A.Expr): e is A.LitPat['literal'] {
  switch (e.kind) {
    case 'IntLit':
    case 'FloatLit':
    case 'TextLit':
    case 'BoolLit':
    case 'DurationLit':
      return true;
    case 'Unary':
      return e.op === 'neg' && (e.operand.kind === 'IntLit' || e.operand.kind === 'FloatLit' || e.operand.kind === 'DurationLit');
    default:
      return false;
  }
}
