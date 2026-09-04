/**
 * The canonical printer (language spec §2.2; impl spec §3.2).
 *
 * This is the only formatter. `print(parse(s))` is the canonical form of `s`;
 * `onus fmt` writes it and `onus check` reports E0001 when it differs from
 * the source. The layout is a pure function of the AST and the comment table:
 *
 *   - two-space indentation; one blank line between top-level items and
 *     between interface/impl members; no blank lines inside blocks;
 *   - a bracketed list (parameters, arguments, type arguments, list literal,
 *     record fields) prints on one line when the line fits in 100 columns and
 *     one element per line otherwise;
 *   - `try ... else` breaks before `else` when the line does not fit;
 *   - contracts, `claims` and loop clauses each take a line indented under
 *     their header, with the opening `{` on its own line;
 *   - binary expressions never break; the minimal parentheses are printed;
 *   - a record constructor, record update or `fake` in a condition position
 *     is parenthesised (the parser does not read `{` there).
 */
import { concat, group, hardline, indent, join, line, lineSuffix, render, softline, type Doc } from './doc.js';
import type * as A from './ast.js';
import { NO_COMMENTS, type CommentTable } from './comments.js';

export const LINE_WIDTH = 100;

export interface PrintOptions {
  /** Print every function body as `{ ... }` (an interface rendering, §11.1). */
  readonly elideBodies: boolean;
}

const DEFAULT_OPTIONS: PrintOptions = { elideBodies: false };

/**
 * Prints a module in canonical form.
 * Postconditions: the result ends with exactly one newline; `parse(result)`
 * equals `module` up to spans.
 * Effects: none.
 */
export function print(module: A.Module, comments: CommentTable = NO_COMMENTS, options: PrintOptions = DEFAULT_OPTIONS): string {
  return render(new Printer(comments, options).module(module), LINE_WIDTH);
}

/**
 * Prints a single item in canonical form without a trailing newline. With the
 * default (empty) comment table this is the comment-free text hashed for
 * definition identity (§2.2).
 * Effects: none.
 */
export function printItem(item: A.Item, comments: CommentTable = NO_COMMENTS, options: PrintOptions = DEFAULT_OPTIONS): string {
  return render(new Printer(comments, options).item(item), LINE_WIDTH);
}

/**
 * Prints a function's signature line: name, parameters, return type and
 * effects, without visibility, claims, contracts or body (§11.1).
 * Effects: none.
 */
export function printSignature(f: A.FnDecl): string {
  return render(new Printer(NO_COMMENTS, DEFAULT_OPTIONS).fnHead(f, false), LINE_WIDTH);
}

/** Prints a statement in canonical form (used to key assumptions in the ledger, §20.3). Effects: none. */
export function printStmt(s: A.Stmt): string {
  return render(new Printer(NO_COMMENTS, DEFAULT_OPTIONS).stmt(s), LINE_WIDTH);
}

/** Prints an expression in canonical form (used in reports and diagnostics). Effects: none. */
export function printExpr(e: A.Expr): string {
  return render(new Printer(NO_COMMENTS, DEFAULT_OPTIONS).expr(e, false), LINE_WIDTH);
}

/** Prints a type in canonical form. Effects: none. */
export function printType(t: A.Type): string {
  return render(new Printer(NO_COMMENTS, DEFAULT_OPTIONS).type(t), LINE_WIDTH);
}

const EMPTY = '';

class Printer {
  constructor(
    private readonly comments: CommentTable,
    private readonly options: PrintOptions,
  ) {}

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  private lineNode(n: A.Node, doc: Doc): Doc {
    const cs = this.comments.get(n.id);
    if (cs === undefined) return doc;
    const parts: Doc[] = [];
    for (const c of cs.leading) parts.push(c, hardline);
    if (cs.trailing.length > 0) parts.push(lineSuffix(` ${cs.trailing.join(' ')}`));
    parts.push(doc);
    return concat(...parts);
  }

  private dangling(n: A.Node): Doc {
    const cs = this.comments.get(n.id);
    if (cs === undefined || cs.dangling.length === 0) return EMPTY;
    return concat(...cs.dangling.map((c) => concat(hardline, c)));
  }

  private hasDangling(n: A.Node): boolean {
    const cs = this.comments.get(n.id);
    return cs !== undefined && cs.dangling.length > 0;
  }

  // -------------------------------------------------------------------------
  // Module and items
  // -------------------------------------------------------------------------

  module(m: A.Module): Doc {
    const parts: Doc[] = [this.lineNode(m, concat(m.test ? 'test ' : EMPTY, 'module ', qn(m.name)))];
    for (const imp of m.imports) parts.push(hardline, this.lineNode(imp, concat('import ', qn(imp.name))));
    for (const it of m.items) parts.push(hardline, hardline, this.item(it));
    // Comments after the last item stand as a final paragraph.
    const cs = this.comments.get(m.id);
    if (cs !== undefined && cs.dangling.length > 0) {
      parts.push(hardline);
      for (const c of cs.dangling) parts.push(hardline, c);
    }
    parts.push(hardline);
    return concat(...parts);
  }

  item(it: A.Item): Doc {
    return this.lineNode(it, this.itemBody(it));
  }

  private itemBody(it: A.Item): Doc {
    switch (it.kind) {
      case 'FnDecl':
        return this.fnDecl(it);
      case 'TypeAlias':
        return concat(vis(it.vis), 'type ', it.name.text, ' = ', this.type(it.type));
      case 'IntrinsicType':
        return concat(vis(it.vis), 'intrinsic type ', it.name.text, this.tparams(it.tparams));
      case 'ConstDecl':
        return concat(vis(it.vis), 'const ', it.name.text, ': ', this.type(it.type), ' = ', this.expr(it.value, false));
      case 'RecordDecl':
        return concat(
          vis(it.vis),
          'record ',
          it.name.text,
          this.tparams(it.tparams),
          ' {',
          indent(concat(...it.fields.map((f) => concat(hardline, this.field(f))), this.dangling(it))),
          hardline,
          '}',
        );
      case 'UnionDecl':
        return concat(
          vis(it.vis),
          'union ',
          it.name.text,
          this.tparams(it.tparams),
          ' =',
          indent(concat(...it.variants.map((v) => concat(hardline, this.variant(v))))),
        );
      case 'InterfaceDecl':
        return concat(
          vis(it.vis),
          'interface ',
          it.name.text,
          '[',
          it.tparam.text,
          '] {',
          indent(concat(...it.items.map((m, i) => concat(hardline, i > 0 ? hardline : EMPTY, this.ifaceItem(m))), this.dangling(it))),
          hardline,
          '}',
        );
      case 'ImplDecl':
        return concat(
          'impl ',
          it.iface.text,
          '[',
          this.type(it.target),
          '] {',
          indent(concat(...it.fns.map((f, i) => concat(hardline, i > 0 ? hardline : EMPTY, this.item(f))), this.dangling(it))),
          hardline,
          '}',
        );
      case 'ClaimDecl':
        return it.body.kind === 'Derived'
          ? concat(vis(it.vis), 'claim ', it.name.text, ' := ', this.claimPred(it.body.pred, 0))
          : concat(vis(it.vis), 'claim ', it.name.text, ' ', quote(it.body.description));
      case 'CapabilityDecl':
        return concat(
          vis(it.vis),
          'capability ',
          it.name.text,
          this.tparams(it.tparams),
          indent(concat(...it.grants.map((g) => concat(hardline, this.grant(g))), this.dangling(it))),
        );
      case 'PathDecl':
        return concat(
          'path ',
          it.name.text,
          indent(concat(hardline, 'entry ', it.entry.text, ...it.clauses.map((c) => concat(hardline, this.pathClause(c))), this.dangling(it))),
        );
      case 'PolicyDecl':
        return concat(
          'policy ',
          it.name.text,
          indent(concat(hardline, 'forbid assume outside { ', join(', ', it.outside.map(policyScope)), ' }')),
        );
      case 'ExampleDecl':
        return concat('example ', it.name.text, ' ', this.block(it.body));
      case 'PropertyDecl':
        return concat('property ', it.name.text, this.params(it.params), ' ', this.block(it.body));
    }
  }

  /** The signature line of a function, with or without its visibility prefix. */
  fnHead(f: A.FnDecl, withVis: boolean): Doc {
    return concat(
      withVis ? vis(f.vis) : EMPTY,
      f.constFn ? 'const ' : EMPTY,
      f.intrinsic ? 'intrinsic ' : EMPTY,
      'fn ',
      f.name.text,
      this.tparams(f.tparams),
      this.params(f.params),
      ' -> ',
      this.type(f.ret),
      this.effects(f.effects),
    );
  }

  private fnDecl(f: A.FnDecl): Doc {
    const head = this.fnHead(f, true);
    const tail: Doc[] = [];
    if (f.claims.length > 0) tail.push(hardline, 'claims ', join(', ', f.claims.map(qn)));
    for (const c of f.contracts) tail.push(hardline, this.contract(c));
    tail.push(this.dangling(f));
    if (f.body === null) return concat(head, indent(concat(...tail)));
    if (f.claims.length === 0 && f.contracts.length === 0 && !this.hasDangling(f)) {
      return concat(head, ' ', this.body(f.body));
    }
    return concat(head, indent(concat(...tail)), hardline, this.body(f.body));
  }

  /** A function body: elided to `{ ... }` when the block is elided or the options say so. */
  private body(b: A.Block): Doc {
    return this.options.elideBodies || b.elided ? '{ ... }' : this.block(b);
  }

  private contract(c: A.Contract): Doc {
    return this.lineNode(c, concat(c.clause, ' ', c.proved ? 'proved ' : EMPTY, this.expr(c.expr, true)));
  }

  private field(f: A.Field): Doc {
    return this.lineNode(f, concat(f.name.text, ': ', this.type(f.type)));
  }

  private variant(v: A.Variant): Doc {
    const fields = v.fields.length > 0 ? concat(' of ', join(', ', v.fields.map((f) => this.field(f)))) : EMPTY;
    return this.lineNode(v, concat('| ', v.name.text, fields));
  }

  private ifaceItem(m: A.IfaceItem): Doc {
    if (m.kind === 'Law') {
      return this.lineNode(m, concat('law ', m.name.text, this.params(m.params), ' ', this.block(m.body)));
    }
    const head = concat('fn ', m.name.text, this.params(m.params), ' -> ', this.type(m.ret), this.effects(m.effects));
    const tail: Doc[] = [];
    for (const c of m.contracts) tail.push(hardline, this.contract(c));
    tail.push(this.dangling(m));
    return this.lineNode(m, concat(head, indent(concat(...tail))));
  }

  private grant(g: A.Grant): Doc {
    return this.lineNode(g, concat('grants ', qn(g.effect.name), g.when ? concat(' when ', this.expr(g.when, true)) : EMPTY));
  }

  private pathClause(c: A.PathClause): Doc {
    switch (c.kind) {
      case 'PathEffects':
        return this.lineNode(c, concat('effects <= ', effectSet(c.effects)));
      case 'PathForbid':
        return this.lineNode(c, concat('forbid ', effectSet(c.effects)));
      case 'PathRequire':
        return this.lineNode(c, concat('require ', c.claims.length > 0 ? concat('{ ', join(', ', c.claims.map(qn)), ' }') : '{}'));
      case 'PathPolicy':
        return this.lineNode(
          c,
          concat('policy ', c.name.text, c.except.length > 0 ? concat(' except { ', join(', ', c.except.map(qn)), ' }') : EMPTY),
        );
    }
  }

  private claimPred(p: A.ClaimPred, minPrec: number): Doc {
    const prec = claimPrec(p);
    const doc = this.claimPredBody(p);
    return prec < minPrec ? concat('(', doc, ')') : doc;
  }

  private claimPredBody(p: A.ClaimPred): Doc {
    switch (p.kind) {
      case 'ClaimAtom':
        return qn(p.name);
      case 'ClaimEffectsEq':
        return concat('effects == ', effectSet(p.effects));
      case 'ClaimNot':
        return concat('not ', this.claimPred(p.operand, 3));
      case 'ClaimAnd':
        return join(' and ', p.operands.map((o) => this.claimPred(o, 2)));
      case 'ClaimOr':
        return join(' or ', p.operands.map((o) => this.claimPred(o, 2)));
    }
  }

  // -------------------------------------------------------------------------
  // Signatures and types
  // -------------------------------------------------------------------------

  private tparams(ps: readonly A.TParam[]): Doc {
    if (ps.length === 0) return EMPTY;
    return bracketed('[', ']', ps.map((p) => this.tparam(p)), EMPTY, true);
  }

  private tparam(p: A.TParam): Doc {
    switch (p.kind) {
      case 'TypeParam':
        return p.bound ? concat(p.name.text, ': ', p.bound.text) : p.name.text;
      case 'ConstParam':
        return concat('const ', p.name.text, ': ', this.type(p.type));
      case 'EffectParam':
        return p.name.text;
    }
  }

  private params(ps: readonly A.Param[]): Doc {
    return bracketed('(', ')', ps.map((p) => this.lineNode(p, concat(p.name.text, ': ', p.inout ? 'inout ' : EMPTY, this.type(p.type)))), EMPTY, true);
  }

  private effects(es: readonly A.EffectRef[]): Doc {
    if (es.length === 0) return EMPTY;
    return concat(' may ', join(', ', es.map((e) => qn(e.name))));
  }

  type(t: A.Type): Doc {
    if (t.kind === 'FnType') {
      const params = t.params.map((p) => concat(p.name.text, ': ', p.inout ? 'inout ' : EMPTY, this.type(p.type)));
      return concat('fn(', join(', ', params), ') -> ', this.type(t.ret), this.effects(t.effects));
    }
    // Type argument lists never break: a type must read as one token-like unit.
    const args = t.args.length > 0 ? concat('[', join(', ', t.args.map((a) => this.typeArg(a))), ']') : EMPTY;
    return concat(qn(t.name), args, t.where ? concat(' where ', this.expr(t.where, false)) : EMPTY);
  }

  private typeArg(a: A.TypeArg): Doc {
    const label = a.label ? concat(a.label.text, ': ') : EMPTY;
    return this.lineNode(a, concat(label, a.kind === 'TypeArgType' ? this.type(a.type) : this.expr(a.expr, false)));
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): Doc {
    if (b.elided) return '{ ... }';
    return concat('{', indent(concat(...b.stmts.map((s) => concat(hardline, this.stmt(s))), this.dangling(b))), hardline, '}');
  }

  stmt(s: A.Stmt): Doc {
    return this.lineNode(s, this.stmtBody(s));
  }

  private stmtBody(s: A.Stmt): Doc {
    switch (s.kind) {
      case 'Let':
        return concat('let ', s.name.text, ': ', this.type(s.type), ' = ', this.expr(s.value, false));
      case 'Var':
        return concat('var ', s.name.text, ': ', this.type(s.type), ' = ', this.expr(s.value, false));
      case 'Assign':
        return concat(s.name.text, ' = ', this.expr(s.value, false));
      case 'Return':
        return concat('return ', this.expr(s.value, false));
      case 'If':
        return concat('if ', this.expr(s.cond, true), ' ', this.block(s.then), s.else ? concat(' else ', this.block(s.else)) : EMPTY);
      case 'Match':
        return concat('match ', this.expr(s.scrutinee, true), ' with', ...s.arms.map((a) => concat(hardline, this.arm(a))), this.dangling(s));
      case 'Loop': {
        const head = concat('loop while ', this.expr(s.cond, true));
        if (s.clauses.length === 0 && !this.hasDangling(s)) return concat(head, ' ', this.block(s.body));
        const clauses = s.clauses.map((c) => concat(hardline, this.lineNode(c, concat(c.clause, ' ', this.expr(c.expr, true)))));
        return concat(head, indent(concat(...clauses, this.dangling(s))), hardline, this.block(s.body));
      }
      case 'For':
        return concat('for ', s.name.text, ': ', this.type(s.type), ' in ', this.domain(s.domain, true), ' ', this.block(s.body));
      case 'Assume': {
        const head = concat('assume ', qn(s.claim), ' ', quote(s.justification));
        if (s.verify === null) return head;
        const v = s.verify;
        return concat(head, indent(concat(hardline, 'verify', this.params(v.params), this.effects(v.effects), ' ', this.block(v.body))));
      }
      case 'ExprStmt':
        return this.expr(s.expr, false);
    }
  }

  private arm(a: A.Arm): Doc {
    const guard = a.guard ? concat(' when ', this.expr(a.guard, false)) : EMPTY;
    const body = a.body.kind === 'Block' ? this.block(a.body) : this.stmt(a.body);
    return this.lineNode(a, concat('| ', this.pattern(a.pattern), guard, ' -> ', body));
  }

  private domain(d: A.Domain, nb: boolean): Doc {
    if (d.kind === 'RangeDomain') return concat(this.expr(d.lo, nb), ' ..< ', this.expr(d.hi, nb));
    return this.expr(d.expr, nb);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /**
   * `nb` (no brace): the expression sits where a `{` would begin a block, so
   * brace-led constructs are parenthesised.
   */
  expr(e: A.Expr, nb: boolean): Doc {
    if (nb && (e.kind === 'RecordUpdate' || e.kind === 'Fake' || (e.kind === 'Ctor' && e.fields !== null))) {
      return concat('(', this.expr(e, false), ')');
    }
    switch (e.kind) {
      case 'IntLit':
        return e.value.toString();
      case 'FloatLit':
        return floatText(e.value);
      case 'TextLit':
        return quote(e.value);
      case 'BoolLit':
        return e.value ? 'true' : 'false';
      case 'DurationLit':
        return durationText(e.nanos);
      case 'Name':
        return e.name.text;
      case 'It':
        return 'it';
      case 'ResultRef':
        return 'result';
      case 'Ctor': {
        const args = e.args !== null ? this.args(e.args, e.fields === null ? this.dangling(e) : EMPTY) : EMPTY;
        const fields = e.fields !== null ? this.fieldInits(e.fields, this.dangling(e)) : EMPTY;
        return concat(qn(e.name), args, fields);
      }
      case 'RecordUpdate':
        return group(
          concat(
            '{ ',
            this.expr(e.base, false),
            ' with',
            indent(concat(line, join(concat(',', line), e.fields.map((f) => this.fieldInit(f))), this.dangling(e))),
            line,
            '}',
          ),
        );
      case 'ListLit':
        return bracketed('[', ']', e.elems.map((x) => this.expr(x, false)), EMPTY, true);
      case 'Try': {
        // The else clause is its own group after the operand, so that when the
        // operand's arguments break the clause stays on the closing line. An
        // operand whose greedy tail is an else-less `try` would capture this
        // clause on re-parse, so it is parenthesised.
        const operand = e.else && endsWithOpenTry(e.expr) ? concat('(', this.expr(e.expr, false), ')') : this.expr(e.expr, nb);
        const elseDoc = e.else ? group(indent(concat(line, 'else ', e.else.name.text, ': ', this.expr(e.else.expr, nb)))) : EMPTY;
        return concat('try ', operand, elseDoc);
      }
      case 'Recover':
        return concat('recover ', this.block(e.body));
      case 'Old':
        return concat('old(', e.name.text, ')');
      case 'Quantifier':
        return concat(
          e.quant,
          ' ',
          e.name.text,
          ': ',
          this.type(e.type),
          e.domain ? concat(' in ', this.domain(e.domain, nb)) : EMPTY,
          e.where ? concat(' where ', this.expr(e.where, nb)) : EMPTY,
          ': ',
          this.expr(e.body, nb),
        );
      case 'Closure':
        return concat('fn', this.params(e.params), ' -> ', this.type(e.ret), this.effects(e.effects), ' ', this.block(e.body));
      case 'Fake':
        return concat('fake ', qn(e.capability), this.fieldInits(e.fields, this.dangling(e)));
      case 'Hole':
        return '?';
      case 'FieldAccess':
        return concat(this.operand(e.object, 9, nb), '.', e.name.text);
      case 'Call': {
        // `Foo(...)` is a constructor; a call whose callee is a bare type name
        // (only constructible synthetically) is kept distinct as `(Foo)(...)`.
        const bareCtor = e.callee.kind === 'Ctor' && e.callee.args === null && e.callee.fields === null && e.targs === null;
        return concat(
          bareCtor ? concat('(', this.expr(e.callee, false), ')') : this.operand(e.callee, 9, nb),
          e.targs !== null ? bracketed('[', ']', e.targs.map((a) => this.typeArg(a)), EMPTY, true) : EMPTY,
          this.args(e.args, this.dangling(e)),
        );
      }
      case 'Unary':
        return e.op === 'neg' ? concat('-', this.operand(e.operand, 9, nb)) : concat('not ', this.operand(e.operand, 5, nb));
      case 'Binary': {
        const p = prec(e);
        const nonAssoc = e.op === 'implies' || isCmp(e.op);
        return concat(this.operand(e.left, nonAssoc ? p + 1 : p, nb), ' ', e.op, ' ', this.operand(e.right, p + 1, nb));
      }
      case 'And':
        return join(' and ', e.operands.map((o) => this.operand(o, 4, nb)));
      case 'Or':
        return join(' or ', e.operands.map((o) => this.operand(o, 4, nb)));
      case 'Is':
        return concat(this.operand(e.expr, 6, nb), ' is ', this.pattern(e.pattern));
    }
  }

  private operand(e: A.Expr, minPrec: number, nb: boolean): Doc {
    if (prec(e) < minPrec) return concat('(', this.expr(e, false), ')');
    return this.expr(e, nb);
  }

  private args(args: readonly A.Arg[], dangling: Doc): Doc {
    const items = args.map((a) => this.lineNode(a, concat(a.name.text, ': ', a.inout ? 'inout ' : EMPTY, this.expr(a.value, false))));
    return bracketed('(', ')', items, dangling, true);
  }

  private fieldInits(fields: readonly A.FieldInit[], dangling: Doc): Doc {
    if (fields.length === 0 && dangling === EMPTY) return ' {}';
    return concat(' ', bracketed('{', '}', fields.map((f) => this.fieldInit(f)), dangling, false));
  }

  private fieldInit(f: A.FieldInit): Doc {
    return this.lineNode(f, concat(f.name.text, ': ', this.expr(f.value, false)));
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  private pattern(p: A.Pattern): Doc {
    switch (p.kind) {
      case 'WildcardPat':
        return '_';
      case 'BindPat':
        return p.name.text;
      case 'LitPat':
        return this.expr(p.literal, false);
      case 'VariantPat':
        return concat(qn(p.name), p.fields !== null ? concat('(', join(', ', p.fields.map(patField)), ')') : EMPTY);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qn(q: A.QName): string {
  return q.segments.map((s) => s.text).join('.');
}

function vis(v: A.Visibility): string {
  return `${v.pub ? 'pub ' : ''}${v.sealed ? 'sealed ' : ''}`;
}

function effectSet(es: readonly A.EffectRef[]): Doc {
  if (es.length === 0) return '{}';
  return concat('{ ', join(', ', es.map((e) => qn(e.name))), ' }');
}

function policyScope(s: A.PolicyScope): string {
  if (s.name === null) return 'self';
  return s.glob ? `${qn(s.name)}.*` : qn(s.name);
}

function patField(f: A.PatField): string {
  switch (f.kind) {
    case 'PatFieldName':
      return f.name.text;
    case 'PatFieldSkip':
      return '_';
    case 'PatFieldRest':
      return '..';
  }
}

/**
 * A group that prints `open items close` flat, or one item per line when it
 * does not fit. `tight` uses no space inside the brackets when flat.
 */
function bracketed(open: string, close: string, items: readonly Doc[], dangling: Doc, tight: boolean): Doc {
  if (items.length === 0 && dangling === EMPTY) return open + close;
  const sep = tight ? softline : line;
  return group(concat(open, indent(concat(sep, join(concat(',', line), items), dangling)), sep, close));
}

/**
 * True iff the rightmost greedy tail of `e`, following only positions that
 * print without parentheses, is a `try` with no `else`. (A `try` as an
 * operator operand is always parenthesised by `operand`.)
 */
function endsWithOpenTry(e: A.Expr): boolean {
  switch (e.kind) {
    case 'Try':
      return e.else === null ? true : endsWithOpenTry(e.else.expr);
    case 'Quantifier':
      return endsWithOpenTry(e.body);
    default:
      return false;
  }
}

function isCmp(op: A.BinaryOp): boolean {
  return op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=';
}

/** Binding strength; higher binds tighter. */
function prec(e: A.Expr): number {
  switch (e.kind) {
    case 'Try':
    case 'Quantifier':
      return 1;
    case 'Binary':
      if (e.op === 'implies') return 2;
      if (isCmp(e.op)) return 5;
      if (e.op === '*' || e.op === '/' || e.op === '%') return 7;
      return 6;
    case 'And':
    case 'Or':
      return 3;
    case 'Unary':
      return e.op === 'not' ? 4 : 8;
    case 'Is':
      return 5;
    case 'FieldAccess':
    case 'Call':
      return 9;
    default:
      return 10;
  }
}

function claimPrec(p: A.ClaimPred): number {
  switch (p.kind) {
    case 'ClaimAnd':
    case 'ClaimOr':
      return 1;
    case 'ClaimNot':
      return 2;
    default:
      return 3;
  }
}

/** Canonical float text: shortest round-tripping form, always with `.` or an exponent. */
export function floatText(v: number): string {
  const s = String(v);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Canonical duration text: the largest unit that divides the value exactly. */
export function durationText(nanos: bigint): string {
  if (nanos % 1_000_000_000n === 0n) return `${nanos / 1_000_000_000n}s`;
  if (nanos % 1_000_000n === 0n) return `${nanos / 1_000_000n}ms`;
  if (nanos % 1_000n === 0n) return `${nanos / 1_000n}us`;
  return `${nanos}ns`;
}

/** Canonical text literal: escapes `\\`, `"`, newline, tab, carriage return and NUL. */
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\0':
        out += '\\0';
        break;
      default:
        out += ch;
    }
  }
  return `${out}"`;
}
