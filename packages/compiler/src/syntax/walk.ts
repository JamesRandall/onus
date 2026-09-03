/**
 * Generic traversal over the AST.
 */
import type * as A from './ast.js';

/**
 * The direct child nodes of `n`, in source order.
 * Effects: none.
 */
export function children(n: A.Node): A.Node[] {
  switch (n.kind) {
    case 'Module':
      return [...n.imports, ...n.items];
    case 'Import':
      return [];
    case 'FnDecl':
      return [...n.tparams, ...n.params, n.ret, ...n.effects, ...n.contracts, ...(n.body ? [n.body] : [])];
    case 'TypeAlias':
      return [n.type];
    case 'IntrinsicType':
      return [...n.tparams];
    case 'ConstDecl':
      return [n.type, n.value];
    case 'RecordDecl':
      return [...n.tparams, ...n.fields];
    case 'Field':
      return [n.type];
    case 'UnionDecl':
      return [...n.tparams, ...n.variants];
    case 'Variant':
      return [...n.fields];
    case 'InterfaceDecl':
      return [...n.items];
    case 'IfaceFn':
      return [...n.params, n.ret, ...n.effects, ...n.contracts];
    case 'Law':
      return [...n.params, n.body];
    case 'ImplDecl':
      return [n.target, ...n.fns];
    case 'ClaimDecl':
      return n.body.kind === 'Derived' ? [n.body.pred] : [];
    case 'ClaimAtom':
      return [];
    case 'ClaimEffectsEq':
      return [...n.effects];
    case 'ClaimNot':
      return [n.operand];
    case 'ClaimAnd':
    case 'ClaimOr':
      return [...n.operands];
    case 'CapabilityDecl':
      return [...n.tparams, ...n.grants];
    case 'Grant':
      return n.when ? [n.effect, n.when] : [n.effect];
    case 'PathDecl':
      return [...n.clauses];
    case 'PathEffects':
    case 'PathForbid':
      return [...n.effects];
    case 'PathRequire':
    case 'PathPolicy':
      return [];
    case 'PolicyDecl':
      return [...n.outside];
    case 'PolicyScope':
      return [];
    case 'ExampleDecl':
      return [n.body];
    case 'PropertyDecl':
      return [...n.params, n.body];
    case 'TypeParam':
    case 'EffectParam':
      return [];
    case 'ConstParam':
      return [n.type];
    case 'Param':
      return [n.type];
    case 'EffectRef':
      return [];
    case 'Contract':
      return [n.expr];
    case 'NamedType':
      return n.where ? [...n.args, n.where] : [...n.args];
    case 'FnType':
      return [...n.params, n.ret, ...n.effects];
    case 'TypeArgType':
      return [n.type];
    case 'TypeArgConst':
      return [n.expr];
    case 'Block':
      return [...n.stmts];
    case 'Let':
    case 'Var':
      return [n.type, n.value];
    case 'Assign':
      return [n.value];
    case 'Return':
      return [n.value];
    case 'If':
      return n.else ? [n.cond, n.then, n.else] : [n.cond, n.then];
    case 'Match':
      return [n.scrutinee, ...n.arms];
    case 'Arm':
      return n.guard ? [n.pattern, n.guard, n.body] : [n.pattern, n.body];
    case 'Loop':
      return [n.cond, ...n.clauses, n.body];
    case 'LoopClause':
      return [n.expr];
    case 'For':
      return [n.type, n.domain, n.body];
    case 'RangeDomain':
      return [n.lo, n.hi];
    case 'InDomain':
      return [n.expr];
    case 'Assume':
      return [];
    case 'ExprStmt':
      return [n.expr];
    case 'IntLit':
    case 'FloatLit':
    case 'TextLit':
    case 'BoolLit':
    case 'DurationLit':
    case 'Name':
    case 'It':
    case 'ResultRef':
    case 'Old':
      return [];
    case 'Ctor':
      return [...(n.args ?? []), ...(n.fields ?? [])];
    case 'FieldInit':
      return [n.value];
    case 'RecordUpdate':
      return [n.base, ...n.fields];
    case 'ListLit':
      return [...n.elems];
    case 'Try':
      return n.else ? [n.expr, n.else] : [n.expr];
    case 'TryElse':
      return [n.expr];
    case 'Recover':
      return [n.body];
    case 'Quantifier': {
      const out: A.Node[] = [n.type];
      if (n.domain) out.push(n.domain);
      if (n.where) out.push(n.where);
      out.push(n.body);
      return out;
    }
    case 'Closure':
      return [...n.params, n.ret, ...n.effects, n.body];
    case 'Fake':
      return [...n.fields];
    case 'Hole':
      return [];
    case 'FieldAccess':
      return [n.object];
    case 'Call':
      return [n.callee, ...(n.targs ?? []), ...n.args];
    case 'Arg':
      return [n.value];
    case 'Unary':
      return [n.operand];
    case 'Binary':
      return [n.left, n.right];
    case 'And':
    case 'Or':
      return [...n.operands];
    case 'Is':
      return [n.expr, n.pattern];
    case 'WildcardPat':
    case 'PatFieldSkip':
    case 'PatFieldRest':
    case 'PatFieldName':
    case 'BindPat':
      return [];
    case 'LitPat':
      return [n.literal];
    case 'VariantPat':
      return [...(n.fields ?? [])];
  }
}

/**
 * Pre-order traversal. `visit` returning false skips the node's children.
 * Effects: those of `visit`.
 */
export function walk(root: A.Node, visit: (n: A.Node) => boolean | void): void {
  const stack: A.Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    if (visit(n) === false) continue;
    const cs = children(n);
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (c !== undefined) stack.push(c);
    }
  }
}

/** True iff `n` is an expression node. Effects: none. */
export function isExpr(n: A.Node): n is A.Expr {
  switch (n.kind) {
    case 'IntLit':
    case 'FloatLit':
    case 'TextLit':
    case 'BoolLit':
    case 'DurationLit':
    case 'Name':
    case 'It':
    case 'ResultRef':
    case 'Ctor':
    case 'RecordUpdate':
    case 'ListLit':
    case 'Try':
    case 'Recover':
    case 'Old':
    case 'Quantifier':
    case 'Closure':
    case 'Fake':
    case 'Hole':
    case 'FieldAccess':
    case 'Call':
    case 'Unary':
    case 'Binary':
    case 'And':
    case 'Or':
    case 'Is':
      return true;
    default:
      return false;
  }
}
