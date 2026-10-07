// GROQ syntax tree. Every node keeps its UTF-16 span in the source query; parentheses are `Group` nodes and
// literals keep their original spelling, so printing a parsed query reproduces its tokens exactly.

export interface Span {
  /** UTF-16 offsets in the source query; synthesized nodes reuse the span of the text they replace. */
  start: number;
  end: number;
}

/** `*` */
export interface Everything extends Span {
  type: "Everything";
}

/** `@` */
export interface This extends Span {
  type: "This";
}

/** `^`, `^.^`, … */
export interface Parent extends Span {
  type: "Parent";
  levels: number;
}

/** An attribute of the current scope, or one of the keywords `true`, `false` and `null`. */
export interface Identifier extends Span {
  type: "Identifier";
  name: string;
}

export interface StringLiteral extends Span {
  type: "String";
  /** Spelling including quotes and escapes. */
  raw: string;
  /** Decoded value (GROQ specification semantics). */
  value: string;
}

export interface NumberLiteral extends Span {
  type: "Number";
  raw: string;
  value: number;
}

/** `$name` */
export interface Parameter extends Span {
  type: "Parameter";
  name: string;
}

/** `(expr)`: never removed, because parentheses end traversals. */
export interface Group extends Span {
  type: "Group";
  expr: Node;
}

/** `(a, b)` */
export interface Tuple extends Span {
  type: "Tuple";
  members: Node[];
}

export interface ArrayElement extends Span {
  value: Node;
  /** `...value` */
  splat: boolean;
}

export interface ArrayLiteral extends Span {
  type: "Array";
  elements: ArrayElement[];
  trailingComma: boolean;
}

/** `"key": value` */
export interface KeyedMember extends Span {
  type: "Keyed";
  key: StringLiteral;
  value: Node;
}

/** A member with an implicit key (`name`, `image{…}`) or a conditional `cond => {…}`. */
export interface ExpressionMember extends Span {
  type: "Expression";
  value: Node;
}

/** `...` or `...value` */
export interface SpreadMember extends Span {
  type: "Spread";
  value: Node | null;
}

export type ObjectMember = KeyedMember | ExpressionMember | SpreadMember;

export interface ObjectLiteral extends Span {
  type: "Object";
  members: ObjectMember[];
  trailingComma: boolean;
}

export interface Prefix extends Span {
  type: "Prefix";
  op: "-" | "+" | "!";
  expr: Node;
}

export type BinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "match"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**";

export interface Binary extends Span {
  type: "Binary";
  op: BinaryOperator;
  left: Node;
  right: Node;
  /** `x in (y)`: groq-js consumes these parentheses itself instead of producing a group. */
  parens: boolean;
}

/** `x in low..high` or `x in (low...high)` */
export interface InRange extends Span {
  type: "InRange";
  left: Node;
  low: Node;
  high: Node;
  exclusive: boolean;
  parens: boolean;
}

/** `condition => value` */
export interface Pair extends Span {
  type: "Pair";
  left: Node;
  right: Node;
}

/** `expr asc`, `expr desc` */
export interface Order extends Span {
  type: "Order";
  expr: Node;
  direction: "asc" | "desc";
}

/** `name(args)` or `namespace::name(args)` */
export interface Call extends Span {
  type: "Call";
  namespace: string | null;
  name: string;
  args: Node[];
  trailingComma: boolean;
}

/** `base | call` */
export interface Pipe extends Span {
  type: "Pipe";
  base: Node;
  call: Call;
}

/** `base.name` */
export interface Attribute extends Span {
  type: "Attribute";
  base: Node;
  name: string;
}

/** `base[expr]`: element access, attribute access or filter, depending on the expression. */
export interface Bracket extends Span {
  type: "Bracket";
  base: Node;
  expr: Node;
}

/** `base[low..high]` */
export interface Slice extends Span {
  type: "Slice";
  base: Node;
  low: Node;
  high: Node;
  exclusive: boolean;
}

/** `base[]` */
export interface ArrayPostfix extends Span {
  type: "ArrayPostfix";
  base: Node;
}

/** `base{…}` or `base|{…}` */
export interface Projection extends Span {
  type: "Projection";
  base: Node;
  object: ObjectLiteral;
  pipe: boolean;
}

/** `base->` or `base->attr` */
export interface Deref extends Span {
  type: "Deref";
  base: Node;
  attr: string | null;
}

export type Node =
  | Everything
  | This
  | Parent
  | Identifier
  | StringLiteral
  | NumberLiteral
  | Parameter
  | Group
  | Tuple
  | ArrayLiteral
  | ObjectLiteral
  | Prefix
  | Binary
  | InRange
  | Pair
  | Order
  | Call
  | Pipe
  | Attribute
  | Bracket
  | Slice
  | ArrayPostfix
  | Projection
  | Deref;

/** Traversal operators: a chain of them after a base forms one groq-js traversal. */
export type TraversalNode = Attribute | Bracket | Slice | ArrayPostfix | Projection | Deref;

export const isTraversal = (node: Node): node is TraversalNode =>
  node.type === "Attribute" ||
  node.type === "Bracket" ||
  node.type === "Slice" ||
  node.type === "ArrayPostfix" ||
  node.type === "Projection" ||
  node.type === "Deref";

/** `fn namespace::name($param) = body;` */
export interface FunctionDeclaration extends Span {
  namespace: string;
  name: string;
  params: string[];
  body: Node;
}

export interface Program extends Span {
  functions: FunctionDeclaration[];
  body: Node;
}

export const KEYWORD_VALUES: ReadonlySet<string> = new Set(["true", "false", "null"]);
