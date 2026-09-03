/**
 * Property test (impl spec §10): for a generated AST `t`,
 * `parse(print(t))` equals `t` up to spans and reports no diagnostics.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type * as A from '../../src/syntax/ast.js';
import { nodeId, renumber } from '../../src/syntax/ast.js';
import { parse } from '../../src/syntax/parser.js';
import { print } from '../../src/syntax/printer.js';
import { equalIgnoringSpans, firstDifference } from '../../src/syntax/equal.js';
import { Context } from '../../src/context.js';
import { fileId, type Span } from '../../src/source.js';
import { toText } from '../../src/report/diagnostic.js';

const SPAN: Span = { file: fileId(0), start: 0, end: 0 };
const ID = nodeId(0);

const lowerName = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/).filter((s) => !RESERVED.has(s));
const upperName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,6}$/);
const RESERVED = new Set([
  'module', 'import', 'test', 'pub', 'sealed', 'fn', 'const', 'type', 'record', 'union', 'of',
  'interface', 'impl', 'law', 'claim', 'capability', 'grants', 'when', 'path', 'entry', 'effects',
  'forbid', 'require', 'policy', 'assume', 'outside', 'except', 'example', 'property', 'requires',
  'ensures', 'proved', 'claims', 'let', 'var', 'return', 'if', 'else', 'match', 'with', 'loop',
  'while', 'invariant', 'decreases', 'for', 'in', 'and', 'or', 'not', 'implies', 'is', 'it',
  'result', 'try', 'recover', 'old', 'forall', 'exists', 'fake', 'inout', 'where', 'true', 'false',
  'self', 'intrinsic',
]);

/** A fresh node per draw: nodes must not be shared, since ids are assigned per occurrence. */
function fresh<T>(make: () => T): fc.Arbitrary<T> {
  return fc.constant(null).map(() => make());
}

function ident(text: string): A.Ident {
  return { text, span: SPAN };
}
function qname(...parts: string[]): A.QName {
  return { segments: parts.map(ident), span: SPAN };
}

const literal: fc.Arbitrary<A.Expr> = fc.oneof(
  fc.bigInt({ min: 0n, max: (1n << 63n) - 1n }).map((value): A.Expr => ({ id: ID, kind: 'IntLit', span: SPAN, value })),
  fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true }).map((value): A.Expr => ({ id: ID, kind: 'FloatLit', span: SPAN, value })),
  fc.string().map((value): A.Expr => ({ id: ID, kind: 'TextLit', span: SPAN, value })),
  fc.boolean().map((value): A.Expr => ({ id: ID, kind: 'BoolLit', span: SPAN, value })),
  fc.bigInt({ min: 0n, max: 10n ** 12n }).map((nanos): A.Expr => ({ id: ID, kind: 'DurationLit', span: SPAN, nanos })),
  lowerName.map((n): A.Expr => ({ id: ID, kind: 'Name', span: SPAN, name: ident(n) })),
  fresh((): A.Expr => ({ id: ID, kind: 'It', span: SPAN })),
  fresh((): A.Expr => ({ id: ID, kind: 'ResultRef', span: SPAN })),
  lowerName.map((n): A.Expr => ({ id: ID, kind: 'Old', span: SPAN, name: ident(n) })),
);

const namedType: fc.Arbitrary<A.Type> = upperName.map((n) => ({ id: ID, kind: 'NamedType', span: SPAN, name: qname(n), args: [], where: null }));

const pattern: fc.Arbitrary<A.Pattern> = fc.oneof(
  fresh((): A.Pattern => ({ id: ID, kind: 'WildcardPat', span: SPAN })),
  lowerName.map((n): A.Pattern => ({ id: ID, kind: 'BindPat', span: SPAN, name: ident(n) })),
  fc.tuple(upperName, fc.option(fc.array(fc.oneof(
    lowerName.map((n): A.PatField => ({ id: ID, kind: 'PatFieldName', span: SPAN, name: ident(n) })),
    fresh((): A.PatField => ({ id: ID, kind: 'PatFieldSkip', span: SPAN })),
  ), { minLength: 1, maxLength: 3 }), { nil: null })).map(([n, fields]): A.Pattern => ({ id: ID, kind: 'VariantPat', span: SPAN, name: qname(n), fields })),
);

const expr: fc.Arbitrary<A.Expr> = fc.letrec<{ expr: A.Expr }>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    literal,
    fc.tuple(fc.constantFrom<A.BinaryOp>('*', '/', '%', '+', '-', '++', '==', '!=', '<', '<=', '>', '>=', 'implies'), tie('expr'), tie('expr'))
      .map(([op, left, right]): A.Expr => ({ id: ID, kind: 'Binary', span: SPAN, op, left, right })),
    fc.array(tie('expr'), { minLength: 2, maxLength: 3 }).map((operands): A.Expr => ({ id: ID, kind: 'And', span: SPAN, operands })),
    fc.array(tie('expr'), { minLength: 2, maxLength: 3 }).map((operands): A.Expr => ({ id: ID, kind: 'Or', span: SPAN, operands })),
    fc.tuple(fc.constantFrom<A.UnaryOp>('neg', 'not'), tie('expr')).map(([op, operand]): A.Expr => ({ id: ID, kind: 'Unary', span: SPAN, op, operand })),
    fc.tuple(tie('expr'), lowerName).map(([object, n]): A.Expr => ({ id: ID, kind: 'FieldAccess', span: SPAN, object, name: ident(n) })),
    fc.tuple(tie('expr'), fc.array(fc.tuple(lowerName, fc.boolean(), tie('expr')), { maxLength: 3 }))
      .map(([callee, args]): A.Expr => ({
        id: ID, kind: 'Call', span: SPAN, callee, targs: null,
        args: args.map(([n, inout, value]): A.Arg => ({ id: ID, kind: 'Arg', span: SPAN, name: ident(n), inout, value })),
      })),
    fc.tuple(upperName, fc.option(fc.array(fc.tuple(lowerName, tie('expr')), { maxLength: 2 }), { nil: null }), fc.option(fc.array(fc.tuple(lowerName, tie('expr')), { maxLength: 2 }), { nil: null }))
      .map(([n, args, fields]): A.Expr => ({
        id: ID, kind: 'Ctor', span: SPAN, name: qname(n),
        args: args === null ? null : args.map(([an, value]): A.Arg => ({ id: ID, kind: 'Arg', span: SPAN, name: ident(an), inout: false, value })),
        fields: fields === null ? null : fields.map(([fnm, value]): A.FieldInit => ({ id: ID, kind: 'FieldInit', span: SPAN, name: ident(fnm), value })),
      })),
    fc.tuple(tie('expr'), fc.array(fc.tuple(lowerName, tie('expr')), { minLength: 1, maxLength: 2 }))
      .map(([base, fields]): A.Expr => ({
        id: ID, kind: 'RecordUpdate', span: SPAN, base,
        fields: fields.map(([fnm, value]): A.FieldInit => ({ id: ID, kind: 'FieldInit', span: SPAN, name: ident(fnm), value })),
      })),
    fc.array(tie('expr'), { maxLength: 3 }).map((elems): A.Expr => ({ id: ID, kind: 'ListLit', span: SPAN, elems })),
    fc.tuple(tie('expr'), fc.option(fc.tuple(lowerName, tie('expr')), { nil: null }))
      .map(([e, els]): A.Expr => ({
        id: ID, kind: 'Try', span: SPAN, expr: e,
        else: els === null ? null : { id: ID, kind: 'TryElse', span: SPAN, name: ident(els[0]), expr: els[1] },
      })),
    fc.tuple(tie('expr'), pattern).map(([e, p]): A.Expr => ({ id: ID, kind: 'Is', span: SPAN, expr: e, pattern: p })),
    fc.tuple(fc.constantFrom<'forall' | 'exists'>('forall', 'exists'), lowerName, namedType, fc.option(tie('expr'), { nil: null }), fc.option(tie('expr'), { nil: null }), tie('expr'))
      .map(([quant, n, type, dom, where, body]): A.Expr => ({
        id: ID, kind: 'Quantifier', span: SPAN, quant, name: ident(n), type,
        domain: dom === null ? null : { id: ID, kind: 'InDomain', span: SPAN, expr: dom },
        where, body,
      })),
  ),
})).expr;

const stmt: fc.Arbitrary<A.Stmt> = fc.oneof(
  fc.tuple(lowerName, namedType, expr).map(([n, type, value]): A.Stmt => ({ id: ID, kind: 'Let', span: SPAN, name: ident(n), type, value })),
  fc.tuple(lowerName, expr).map(([n, value]): A.Stmt => ({ id: ID, kind: 'Assign', span: SPAN, name: ident(n), value })),
  expr.map((value): A.Stmt => ({ id: ID, kind: 'Return', span: SPAN, value })),
  fc.tuple(expr, expr).map(([cond, value]): A.Stmt => ({
    id: ID, kind: 'If', span: SPAN, cond,
    then: { id: ID, kind: 'Block', span: SPAN, stmts: [{ id: ID, kind: 'Return', span: SPAN, value }], elided: false },
    else: null,
  })),
);

function moduleOf(stmts: A.Stmt[]): A.Module {
  const fn: A.FnDecl = {
    id: ID, kind: 'FnDecl', span: SPAN, vis: { pub: false, sealed: false }, constFn: false, intrinsic: false, name: ident('f'),
    tparams: [], params: [], ret: { id: ID, kind: 'NamedType', span: SPAN, name: qname('Int'), args: [], where: null },
    effects: [], claims: [], contracts: [], body: { id: ID, kind: 'Block', span: SPAN, stmts, elided: false },
  };
  const m: A.Module = { id: ID, kind: 'Module', span: SPAN, test: false, name: qname('gen'), imports: [], items: [fn] };
  renumber(m, 0);
  return m;
}

describe('generated ASTs', () => {
  it('print then parse is the identity up to spans', () => {
    fc.assert(
      fc.property(fc.array(stmt, { minLength: 1, maxLength: 4 }), (stmts) => {
        const m = moduleOf(stmts);
        const text = print(m);
        const ctx = new Context();
        const file = ctx.addFile('gen.onus', text);
        const parsed = parse(file, ctx.sink);
        const diags = ctx.sink.all().map((d) => toText(ctx, d));
        if (diags.length > 0) throw new Error(`diagnostics on printed text:\n${text}\n${diags.join('\n')}`);
        if (parsed.module === null) throw new Error('no module');
        const diff = firstDifference(m, parsed.module);
        if (diff !== null) throw new Error(`difference at ${diff}\n${text}`);
        expect(equalIgnoringSpans(m, parsed.module)).toBe(true);
        expect(print(parsed.module)).toBe(text);
      }),
      { numRuns: Number(process.env['FC_RUNS'] ?? 300) },
    );
  });
});
