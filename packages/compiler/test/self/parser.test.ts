/**
 * Milestone 15.1 (impl spec): the parser in Onus (`self/parser.onus`)
 * against the TypeScript parser, on every source in the repository. Both
 * trees are printed in the same one-line form, spans in code points, and
 * the syntax diagnostics (codes and spans) follow; a file with syntax
 * errors compares what both parsers recovered.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { runDriver, selfDriver } from './driver.js';
import { runJsExamples } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { DiagnosticSink, toText } from '../../src/report/diagnostic.js';
import type * as A from '../../src/syntax/ast.js';
import { parse } from '../../src/syntax/parser.js';
import type { Span } from '../../src/source.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');

function checked(entry: string, root: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root, verify: { budgetMs: 3000, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function sources(): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === 'dist' || f === 'out') continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) visit(p);
      else if (f.endsWith('.onus')) out.push(p);
    }
  };
  for (const d of ['examples', 'packages/compiler/test', 'packages/stdlib/std', 'packages/loop/test', 'self']) visit(join(repoRoot, d));
  return out.sort();
}

/** The dump of the TypeScript parser's tree, in the form `self/astdump.onus` prints. */
function expectedDump(path: string, text: string): string {
  const ctx = new Context({ log: () => undefined });
  const file = ctx.addFile(path, text);
  const sink = new DiagnosticSink();
  const r = parse(file, sink);
  const cp = (offset: number): number => Array.from(text.slice(0, offset)).length;
  const sp = (s: Span): string => `@${cp(s.start)}-${cp(s.end)}`;
  const id = (i: A.Ident): string => `${i.text}${sp(i.span)}`;
  const qn = (q: A.QName): string => `q(${q.segments.map((s) => s.text).join('.')})${sp(q.span)}`;
  const b = (x: boolean): string => (x ? 'true' : 'false');
  const quoted = (t: string): string => `t[${Array.from(t, (c) => String(c.codePointAt(0) ?? 0)).join(',')}]`;
  const list = (xs: readonly string[]): string => `[${xs.join(' ')}]`;
  const vis = (v: A.Visibility): string => `vis(${b(v.pub)},${b(v.sealed)})`;
  const digits = (s: Span): string => text.slice(s.start, s.end).replace(/_/g, '');
  const optId = (i: A.Ident | null): string => (i === null ? '-' : id(i));
  const effects = (es: readonly A.EffectRef[]): string => list(es.map((e) => `(Effect ${qn(e.name)}${sp(e.span)})`));
  const tparams = (ps: readonly A.TParam[]): string =>
    list(
      ps.map((t) => {
        if (t.kind === 'TypeParam') return `(TypeParam ${id(t.name)} ${optId(t.bound)}${sp(t.span)})`;
        if (t.kind === 'ConstParam') return `(ConstParam ${id(t.name)} ${type(t.type)}${sp(t.span)})`;
        return `(EffectParam ${id(t.name)}${sp(t.span)})`;
      }),
    );
  const params = (ps: readonly A.Param[]): string => list(ps.map((p) => `(Param inout=${b(p.inout)} ${id(p.name)} ${type(p.type)}${sp(p.span)})`));
  const contracts = (cs: readonly A.Contract[]): string => list(cs.map((c) => `(Contract ${c.clause} proved=${b(c.proved)} ${expr(c.expr)}${sp(c.span)})`));
  const fields = (fs: readonly A.Field[]): string => list(fs.map((f) => `(Field ${id(f.name)} ${type(f.type)}${sp(f.span)})`));
  const targs = (ts: readonly A.TypeArg[]): string => list(ts.map((a) => (a.kind === 'TypeArgType' ? `(TypeArgType ${optId(a.label)} ${type(a.type)}${sp(a.span)})` : `(TypeArgConst ${optId(a.label)} ${expr(a.expr)}${sp(a.span)})`)));
  const type = (t: A.Type): string => {
    if (t.kind === 'NamedType') return `(NamedType ${qn(t.name)} ${targs(t.args)} ${t.where === null ? '-' : expr(t.where)}${sp(t.span)})`;
    return `(FnType ${params(t.params)} ${type(t.ret)} ${effects(t.effects)}${sp(t.span)})`;
  };
  const block = (bl: A.Block): string => `(Block elided=${b(bl.elided)} ${list(bl.stmts.map(stmt))}${sp(bl.span)})`;
  const domain = (d: A.Domain): string => (d.kind === 'RangeDomain' ? `(Range ${expr(d.lo)} ${expr(d.hi)}${sp(d.span)})` : `(In ${expr(d.expr)}${sp(d.span)})`);
  const fieldInits = (fs: readonly A.FieldInit[]): string => list(fs.map((f) => `(FieldInit ${id(f.name)} ${expr(f.value)}${sp(f.span)})`));
  const args = (as: readonly A.Arg[]): string => list(as.map((a) => `(Arg ${id(a.name)} inout=${b(a.inout)} ${expr(a.value)}${sp(a.span)})`));
  const pattern = (p: A.Pattern): string => {
    switch (p.kind) {
      case 'WildcardPat':
        return `(Wild${sp(p.span)})`;
      case 'BindPat':
        return `(Bind ${id(p.name)}${sp(p.span)})`;
      case 'LitPat':
        return `(LitPat ${expr(p.literal)}${sp(p.span)})`;
      case 'VariantPat':
        return `(VariantPat ${qn(p.name)} ${p.fields === null ? '-' : list(p.fields.map((f) => (f.kind === 'PatFieldName' ? `(PName ${id(f.name)}${sp(f.span)})` : f.kind === 'PatFieldSkip' ? `(PSkip${sp(f.span)})` : `(PRest${sp(f.span)})`)))}${sp(p.span)})`;
    }
  };
  const stmt = (s: A.Stmt): string => {
    switch (s.kind) {
      case 'Let':
        return `(Let ${id(s.name)} ${type(s.type)} ${expr(s.value)}${sp(s.span)})`;
      case 'Var':
        return `(Var ${id(s.name)} ${type(s.type)} ${expr(s.value)}${sp(s.span)})`;
      case 'Assign':
        return `(Assign ${id(s.name)} ${expr(s.value)}${sp(s.span)})`;
      case 'Return':
        return `(Return ${expr(s.value)}${sp(s.span)})`;
      case 'If':
        return `(If ${expr(s.cond)} ${block(s.then)} ${s.else === null ? '-' : block(s.else)}${sp(s.span)})`;
      case 'Match':
        return `(Match ${expr(s.scrutinee)} ${list(s.arms.map((a) => `(Arm ${pattern(a.pattern)} ${a.guard === null ? '-' : expr(a.guard)} ${a.body.kind === 'Block' ? block(a.body) : stmt(a.body)}${sp(a.span)})`))}${sp(s.span)})`;
      case 'Loop':
        return `(Loop ${expr(s.cond)} ${list(s.clauses.map((c) => `(LoopClause ${c.clause} ${expr(c.expr)}${sp(c.span)})`))} ${block(s.body)}${sp(s.span)})`;
      case 'For':
        return `(For ${id(s.name)} ${type(s.type)} ${domain(s.domain)} ${block(s.body)}${sp(s.span)})`;
      case 'Assume':
        return `(Assume ${qn(s.claim)} ${quoted(s.justification)} ${s.verify === null ? '-' : `(Verify ${params(s.verify.params)} ${effects(s.verify.effects)} ${block(s.verify.body)}${sp(s.verify.span)})`}${sp(s.span)})`;
      case 'ExprStmt':
        return `(ExprStmt ${expr(s.expr)}${sp(s.span)})`;
    }
  };
  const expr = (e: A.Expr): string => {
    switch (e.kind) {
      case 'IntLit':
        return `(Int ${digits(e.span)}${sp(e.span)})`;
      case 'FloatLit':
        return `(Float ${String(e.value)}${sp(e.span)})`;
      case 'TextLit':
        return `(Text ${quoted(e.value)}${sp(e.span)})`;
      case 'BoolLit':
        return `(Bool ${b(e.value)}${sp(e.span)})`;
      case 'DurationLit':
        return `(Duration ${String(e.nanos)}${sp(e.span)})`;
      case 'Name':
        return `(Name ${id(e.name)}${sp(e.span)})`;
      case 'It':
        return `(It${sp(e.span)})`;
      case 'ResultRef':
        return `(Result${sp(e.span)})`;
      case 'Ctor':
        return `(Ctor ${qn(e.name)} ${e.args === null ? '-' : args(e.args)} ${e.fields === null ? '-' : fieldInits(e.fields)}${sp(e.span)})`;
      case 'RecordUpdate':
        return `(Update ${expr(e.base)} ${fieldInits(e.fields)}${sp(e.span)})`;
      case 'ListLit':
        return `(List ${list(e.elems.map(expr))}${sp(e.span)})`;
      case 'Try':
        return `(Try ${expr(e.expr)} ${e.else === null ? '-' : `(Else ${id(e.else.name)} ${expr(e.else.expr)}${sp(e.else.span)})`}${sp(e.span)})`;
      case 'Recover':
        return `(Recover ${block(e.body)}${sp(e.span)})`;
      case 'Old':
        return `(Old ${id(e.name)}${sp(e.span)})`;
      case 'Quantifier':
        return `(Quant ${e.quant} ${id(e.name)} ${type(e.type)} ${e.domain === null ? '-' : domain(e.domain)} ${e.where === null ? '-' : expr(e.where)} ${expr(e.body)}${sp(e.span)})`;
      case 'Closure':
        return `(Closure ${params(e.params)} ${type(e.ret)} ${effects(e.effects)} ${block(e.body)}${sp(e.span)})`;
      case 'Fake':
        return `(Fake ${qn(e.capability)} ${fieldInits(e.fields)}${sp(e.span)})`;
      case 'Hole':
        return `(Hole${sp(e.span)})`;
      case 'FieldAccess':
        return `(Field ${expr(e.object)} ${id(e.name)}${sp(e.span)})`;
      case 'Call':
        return `(Call ${expr(e.callee)} ${e.targs === null ? '-' : targs(e.targs)} ${args(e.args)}${sp(e.span)})`;
      case 'Unary':
        return `(Unary ${e.op} ${expr(e.operand)}${sp(e.span)})`;
      case 'Binary':
        return `(Binary ${e.op} ${expr(e.left)} ${expr(e.right)}${sp(e.span)})`;
      case 'And':
        return `(And ${list(e.operands.map(expr))}${sp(e.span)})`;
      case 'Or':
        return `(Or ${list(e.operands.map(expr))}${sp(e.span)})`;
      case 'Is':
        return `(Is ${expr(e.expr)} ${pattern(e.pattern)}${sp(e.span)})`;
    }
  };
  const claimPred = (c: A.ClaimPred): string => {
    switch (c.kind) {
      case 'ClaimAtom':
        return `(ClaimAtom ${qn(c.name)}${sp(c.span)})`;
      case 'ClaimEffectsEq':
        return `(ClaimEffectsEq ${effects(c.effects)}${sp(c.span)})`;
      case 'ClaimNot':
        return `(ClaimNot ${claimPred(c.operand)}${sp(c.span)})`;
      case 'ClaimAnd':
        return `(ClaimAnd ${list(c.operands.map(claimPred))}${sp(c.span)})`;
      case 'ClaimOr':
        return `(ClaimOr ${list(c.operands.map(claimPred))}${sp(c.span)})`;
    }
  };
  const fn = (f: A.FnDecl): string => `(Fn ${vis(f.vis)} const=${b(f.constFn)} intrinsic=${b(f.intrinsic)} ${id(f.name)} ${tparams(f.tparams)} ${params(f.params)} ${type(f.ret)} ${effects(f.effects)} ${list(f.claims.map(qn))} ${contracts(f.contracts)} ${f.body === null ? '-' : block(f.body)}${sp(f.span)})`;
  const item = (i: A.Item): string => {
    switch (i.kind) {
      case 'FnDecl':
        return fn(i);
      case 'TypeAlias':
        return `(TypeAlias ${vis(i.vis)} ${id(i.name)} ${type(i.type)}${sp(i.span)})`;
      case 'IntrinsicType':
        return `(IntrinsicType ${vis(i.vis)} ${id(i.name)} ${tparams(i.tparams)}${sp(i.span)})`;
      case 'ConstDecl':
        return `(Const ${vis(i.vis)} ${id(i.name)} ${type(i.type)} ${expr(i.value)}${sp(i.span)})`;
      case 'RecordDecl':
        return `(Record ${vis(i.vis)} ${id(i.name)} ${tparams(i.tparams)} ${fields(i.fields)}${sp(i.span)})`;
      case 'UnionDecl':
        return `(Union ${vis(i.vis)} ${id(i.name)} ${tparams(i.tparams)} ${list(i.variants.map((v) => `(Variant ${id(v.name)} ${fields(v.fields)}${sp(v.span)})`))}${sp(i.span)})`;
      case 'InterfaceDecl':
        return `(Interface ${vis(i.vis)} ${id(i.name)} ${id(i.tparam)} ${list(i.items.map((x) => (x.kind === 'IfaceFn' ? `(IfaceFn ${id(x.name)} ${params(x.params)} ${type(x.ret)} ${effects(x.effects)} ${contracts(x.contracts)}${sp(x.span)})` : `(Law ${id(x.name)} ${params(x.params)} ${block(x.body)}${sp(x.span)})`)))}${sp(i.span)})`;
      case 'ImplDecl':
        return `(Impl ${id(i.iface)} ${type(i.target)} ${list(i.fns.map(fn))}${sp(i.span)})`;
      case 'ClaimDecl':
        return `(Claim ${vis(i.vis)} ${id(i.name)} ${i.body.kind === 'Derived' ? `(Derived ${claimPred(i.body.pred)})` : `(Asserted ${quoted(i.body.description)})`}${sp(i.span)})`;
      case 'CapabilityDecl':
        return `(Capability ${vis(i.vis)} ${id(i.name)} ${tparams(i.tparams)} ${list(i.grants.map((g) => `(Grant (Effect ${qn(g.effect.name)}${sp(g.effect.span)}) ${g.when === null ? '-' : expr(g.when)}${sp(g.span)})`))}${sp(i.span)})`;
      case 'PathDecl':
        return `(Path ${id(i.name)} ${id(i.entry)} ${list(
          i.clauses.map((c) => {
            switch (c.kind) {
              case 'PathEffects':
                return `(PathEffects ${effects(c.effects)}${sp(c.span)})`;
              case 'PathForbid':
                return `(PathForbid ${effects(c.effects)}${sp(c.span)})`;
              case 'PathRequire':
                return `(PathRequire ${list(c.claims.map(qn))}${sp(c.span)})`;
              case 'PathPolicy':
                return `(PathPolicy ${id(c.name)} ${list(c.except.map(qn))}${sp(c.span)})`;
            }
          }),
        )}${sp(i.span)})`;
      case 'PolicyDecl':
        return `(Policy ${id(i.name)} ${list(i.outside.map((s) => `(Scope ${s.name === null ? 'self' : qn(s.name)} glob=${b(s.glob)}${sp(s.span)})`))}${sp(i.span)})`;
      case 'ExampleDecl':
        return `(Example ${id(i.name)} ${block(i.body)}${sp(i.span)})`;
      case 'PropertyDecl':
        return `(Property ${id(i.name)} ${params(i.params)} ${block(i.body)}${sp(i.span)})`;
    }
  };
  const lines: string[] = [];
  const m = r.module;
  if (m === null) lines.push('(no module)');
  else lines.push(`(Module test=${b(m.test)} ${qn(m.name)} ${list(m.imports.map((i) => `(Import ${qn(i.name)}${sp(i.span)})`))} ${list(m.items.map(item))}${sp(m.span)})`);
  for (const d of sink.all()) lines.push(`${d.code} ${cp(d.span.start)} ${cp(d.span.end)}`);
  return `${lines.join('\n')}\n`;
}

describe('the parser in Onus (M15.1)', () => {
  const out = join(tmpRoot, 'astdump');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'astdump.onus'), selfRoot);
  const driver = selfDriver(ctx, out, 'astdump');

  it.skipIf(driver.native)('the self modules\' own examples pass as generated tests', () => {
    const results = runJsExamples(out, true);
    expect(results.size).toBeGreaterThan(0);
    expect([...results].filter(([, ok]) => !ok).map(([n]) => n)).toEqual([]);
  }, 120000);

  it('agrees with the TypeScript parser on every source in the repository', () => {
    const files = sources();
    const disagreements: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const r = runDriver(driver, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) {
        disagreements.push(`${path}: astdump exited ${r.status}: ${r.stderr.slice(0, 500)}`);
        continue;
      }
      const want = expectedDump(path, text);
      if (r.stdout !== want) {
        const a = r.stdout;
        let i = 0;
        while (i < a.length && i < want.length && a[i] === want[i]) i += 1;
        disagreements.push(`${path}: first difference at ${i}\n--- onus:       ${a.slice(Math.max(0, i - 120), i + 160)}\n--- typescript: ${want.slice(Math.max(0, i - 120), i + 160)}`);
      }
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 900000);
});
