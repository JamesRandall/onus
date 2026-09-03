# Onus grammar as implemented (v0, milestone 1)

This is the grammar the parser in `packages/compiler/src/syntax/parser.ts`
accepts. It refines the provisional EBNF in `onus-spec-v0.md` §2.3; every
difference is listed in `CHANGES.md`. The canonical printer accepts exactly
this grammar and prints the canonical form described at the end.

## Lexical structure

- `NAME` = `[a-z][a-z0-9_]*`; `TNAME` = `[A-Z][A-Za-z0-9]*`. An identifier
  matching neither (e.g. `xValue`) is `E0005`.
- Keywords are reserved. *Soft keywords* — `module import test type record
  union interface impl law claim capability grants path entry effects forbid
  require policy outside except example property of self intrinsic` — never appear
  inside an expression, so they are accepted as names in name positions
  (`Float.of`, `auth.require`, `path: "x"`).
- Literals: `INT` = `[0-9][0-9_]*` (64-bit signed; larger is `E0008`);
  `FLOAT` = digits with a `.` fraction and/or an `e` exponent;
  `DURATION` = `INT` followed by `ns`, `us`, `ms` or `s`;
  `TEXT` = `"` ... `"` on one line with escapes `\n \t \r \0 \\ \"`
  (a raw newline is `E0004`; other escapes are `E0009`); `true`, `false`.
- Comments run from `--` to the end of the line. They carry no semantics and
  are excluded from definition hashes, but the canonical printer preserves
  them, attached to the line-level construct they precede or follow.
- `NL` is emitted at a line end outside `(`/`[` brackets, never twice in a
  row, and never before a continuation token: `->`, `else`, `{`, `claims`,
  `requires`, `ensures`, `invariant`, `decreases`. This is what lets a
  signature, a `try ... else` and a loop header span lines while the grammar
  below stays LL(1).

## Grammar

```
module      = [ "test" ] "module" QNAME NL { "import" QNAME NL } { item [ NL ] } EOF ;
QNAME       = NAME { "." NAME } ;
QTNAME      = { NAME "." } TNAME ;
CLAIM       = ( NAME | TNAME ) { "." ( NAME | TNAME ) } ;   (* resolved later *)

item        = fn_decl | type_alias | const_decl | record_decl | union_decl
            | interface_decl | impl_decl | claim_decl | capability_decl
            | path_decl | policy_decl | example_decl | property_decl ;
visibility  = [ "pub" ] [ "sealed" ] ;

fn_decl     = visibility [ "const" ] [ "intrinsic" ] "fn" NAME [ tparams ] "(" [ params ] ")" "->" type
              [ "!" effects ] [ "claims" CLAIM { "," CLAIM } ] { contract } ( block | NL ) ;
              (* an intrinsic function has no body; intrinsics are legal only under `module std.…` *)
tparams     = "[" tparam { "," tparam } "]" ;
tparam      = TNAME [ ":" TNAME ] | "const" NAME ":" type | NAME ;
params      = param { "," param } ;
param       = NAME ":" [ "inout" ] type ;
effects     = effect { "," effect } ;                 (* a "," followed by NAME ":" ends the list *)
effect      = QNAME | "recover" ;
contract    = ( "requires" | "ensures" ) [ "proved" ] expr | "decreases" expr ;

type        = QTNAME [ "[" targ { "," targ } "]" ] [ "where" expr ]
            | "fn" "(" [ params ] ")" "->" type [ "!" effects ] ;   (* parameters are named: the labels for calls *)
targ        = [ NAME ":" ] ( type | expr ) ;          (* uppercase-led is a type; the resolver decides *)

type_alias  = visibility ( "type" TNAME "=" type | "intrinsic" "type" TNAME [ tparams ] ) ;
const_decl  = visibility "const" NAME ":" type "=" expr ;
record_decl = visibility "record" TNAME [ tparams ] "{" NL { field NL } "}" ;
field       = NAME ":" type ;
union_decl  = visibility "union" TNAME [ tparams ] "=" NL { "|" variant NL } ;
variant     = TNAME [ "of" field { "," field } ] ;

interface_decl = visibility "interface" TNAME "[" TNAME "]" "{" NL { iface_item } "}" ;
iface_item  = "fn" NAME "(" [ params ] ")" "->" type [ "!" effects ] { contract } NL
            | "law" NAME "(" [ params ] ")" assert_block NL ;
impl_decl   = "impl" TNAME "[" type "]" "{" NL { fn_decl NL } "}" ;

claim_decl  = visibility "claim" TNAME ( ":=" claim_pred | TEXT ) ;
claim_pred  = claim_and { "or" claim_and } ;          (* and/or may not mix without parentheses *)
claim_and   = claim_not { "and" claim_not } ;
claim_not   = [ "not" ] claim_atom ;
claim_atom  = CLAIM | "effects" "==" "{" [ effects ] "}" | "(" claim_pred ")" ;

capability_decl = visibility "capability" TNAME [ tparams ] NL { "grants" effect [ "when" expr ] NL } ;
path_decl   = "path" NAME NL "entry" NAME NL { path_clause NL } ;
path_clause = "effects" "<=" "{" [ effects ] "}"
            | "forbid" "{" [ effects ] "}"
            | "require" "{" [ CLAIM { "," CLAIM } ] "}"
            | "policy" NAME [ "except" "{" QNAME { "," QNAME } "}" ] ;
policy_decl = "policy" NAME NL "forbid" "assume" "outside" "{" scope { "," scope } "}" ;
scope       = "self" | QNAME [ "." "*" ] ;

example_decl  = "example" NAME assert_block ;
property_decl = "property" NAME "(" [ params ] ")" assert_block ;

block       = "{" ( NL { stmt NL } | [ stmt ] ) "}"       (* single-line form canonicalises to multi-line *)
            | "{" "..." "}" ;                                (* elided fn body of an interface rendering (§11.1); E0115 in source *)
assert_block = block ;                                   (* bare expressions are assertions, not E0002 *)
stmt        = "let" NAME ":" type "=" expr
            | "var" NAME ":" type "=" expr
            | NAME "=" expr
            | "return" expr
            | "if" cond block [ "else" ( block | if_stmt ) ]   (* else-if canonicalises to a nested block *)
            | "match" cond "with" NL { "|" pattern [ "when" expr ] "->" ( block | stmt ) NL }
            | "loop" "while" cond { ( "invariant" | "decreases" ) cond } block
            | "for" NAME ":" type "in" domain block
            | "assume" CLAIM TEXT
            | expr ;                                     (* must be a call or `try` of a call: E0002 *)
cond        = expr ;                                     (* `{` never begins a record constructor here *)
domain      = expr [ "..<" expr ] ;

expr        = or_expr [ "implies" or_expr ] ;            (* a second "implies" is E0011 *)
or_expr     = and_expr { "or" and_expr } ;               (* an unparenthesised and-chain operand is E0007 *)
and_expr    = not_expr { "and" not_expr } ;
not_expr    = [ "not" ] cmp_expr ;
cmp_expr    = add_expr [ CMP_OP add_expr | "is" pattern ] ;   (* a second CMP_OP is E0006 *)
add_expr    = mul_expr { ( "+" | "-" | "++" ) mul_expr } ;
mul_expr    = unary { ( "*" | "/" | "%" ) unary } ;
unary       = [ "-" ] postfix ;
postfix     = primary { "." NAME | "." TNAME ctor_rest | [ "[" targ { "," targ } "]" ] call_args } ;
primary     = INT | FLOAT | TEXT | DURATION | "true" | "false" | NAME | "it" | "result"
            | TNAME ctor_rest
            | "{" expr "with" field_init { "," field_init } "}"
            | "(" expr ")" | "[" [ expr { "," expr } ] "]"
            | "try" expr [ "else" NAME ":" expr ]
            | "recover" block
            | "old" "(" NAME ")"
            | ( "forall" | "exists" ) NAME ":" binder_type [ "in" domain ] [ "where" expr ] ":" expr
            | "fn" "(" [ params ] ")" "->" type [ "!" effects ] block
            | "fake" QTNAME "{" [ field_init { "," field_init } ] "}" ;   (* E0012 outside a test module *)
ctor_rest   = [ call_args ] [ "{" [ field_init { "," field_init } ] "}" ] ;
binder_type = QTNAME [ "[" targ { "," targ } "]" ] | "fn" ... ;   (* no "where": it belongs to the quantifier *)
call_args   = "(" [ NAME ":" [ "inout" ] expr { "," NAME ":" [ "inout" ] expr } ] ")" ;
field_init  = NAME ":" expr ;
pattern     = "_" | NAME | LITERAL | [ "-" ] ( INT | FLOAT | DURATION )
            | QTNAME [ "(" pat_field { "," pat_field } ")" ] ;
pat_field   = NAME | "_" | ".." ;
```

`"." TNAME` after a chain of names folds the chain into a qualified type
name (`sql.Refinement(row: 3)`); after anything else it is `E0003`.

## Canonical form

`print(parse(s))` is the canonical form of `s`. Rules:

- Two-space indentation. One blank line between top-level items and between
  the members of an interface or impl; no blank lines inside blocks.
- A bracketed list (parameters, type arguments at a call, arguments, list
  literal, record constructor or update fields) is printed on one line if
  the line fits in 100 columns, else with one element per line. Type
  argument lists in types never break. Binary expressions never break.
- `try e else n: x` breaks before `else` when the line does not fit; if the
  operand's argument list broke, `else` follows the closing `)`.
- Contracts, `claims` and loop clauses each take an indented line under the
  header and the block's `{` goes on its own line; otherwise `{` ends the
  header line. Match arms align with `match`. Variants and grants indent
  under their header.
- Parentheses are the minimum the grammar requires. `else if` becomes a
  nested `else { if ... }`. A single-line block becomes multi-line.
- Literals: integers without `_`; floats in their shortest round-tripping
  form with a `.` or exponent; durations in the largest unit that divides
  them exactly (`2000ms` → `2s`); text with `\n \t \r \0 \\ \"` escapes.
- Comments: an own-line comment prints on its own line before the following
  line-level construct (or at the end of its container); a same-line comment
  prints at the end of the first line of the construct it followed.
