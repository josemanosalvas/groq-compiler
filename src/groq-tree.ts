// Builds the tree groq-js 2.0.0 `parse()` returns for a syntax tree: a port of its expression builder
// (traversal algebra, constant-folded brackets, implicit object keys and custom function expansion).
// Tests compare it with groq-js on every corpus query; the share pass uses it on small chains, with opaque
// leaves, to decide exactly when a rewrite keeps the tree.
import type { FunctionDeclaration, Node, ObjectLiteral, Program, TraversalNode } from "./ast.js";
import { isTraversal } from "./ast.js";

export interface GroqNode {
  type: string;
  [key: string]: unknown;
}

/** groq-js would throw for this tree (or this port does not model the construct). */
export class GroqTreeError extends Error {
  override name = "GroqTreeError";
}

export interface GroqTreeOptions {
  /** Returns a stand-in for a node (an opaque leaf) instead of converting it. */
  opaque?: (node: Node) => GroqNode | undefined;
}

type Build = (base: GroqNode) => GroqNode;
type TraversalType = "a-a" | "a-b" | "b-a" | "b-b";
interface Traversal {
  type: TraversalType;
  build: Build;
}

const THIS: GroqNode = { type: "This" };
const join =
  (a: Build, b: Build): Build =>
  (base) =>
    b(a(base));
const map =
  (inner: Build): Build =>
  (base) => ({ type: "Map", base, expr: inner(THIS) });
const flatMap =
  (inner: Build): Build =>
  (base) => ({ type: "FlatMap", base, expr: inner(THIS) });

export function traverseArray(build: Build, right: Traversal | null): Traversal {
  if (!right) return { type: "a-a", build };
  switch (right.type) {
    case "a-a":
      return { type: "a-a", build: join(build, right.build) };
    case "a-b":
      return { type: "a-b", build: join(build, right.build) };
    case "b-b":
      return { type: "a-a", build: join(build, map(right.build)) };
    case "b-a":
      return { type: "a-a", build: join(build, flatMap(right.build)) };
  }
}

export function traversePlain(build: Build, right: Traversal | null): Traversal {
  if (!right) return { type: "b-b", build };
  const type = right.type === "a-a" || right.type === "b-a" ? "b-a" : "b-b";
  return { type, build: join(build, right.build) };
}

export function traverseElement(build: Build, right: Traversal | null): Traversal {
  if (!right) return { type: "a-b", build };
  const type = right.type === "a-a" || right.type === "b-a" ? "a-a" : "a-b";
  return { type, build: join(build, right.build) };
}

export function traverseProjection(build: Build, right: Traversal | null): Traversal {
  if (!right) return { type: "b-b", build };
  switch (right.type) {
    case "a-a":
    case "a-b":
      return { type: right.type, build: join(map(build), right.build) };
    case "b-a":
    case "b-b":
      return { type: right.type, build: join(build, right.build) };
  }
}

const GROQ_ESCAPES: Record<string, string> = {
  "'": "'",
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Decodes a string literal the way groq-js does (braced escapes go through `String.fromCharCode`). */
export function groqJsStringValue(raw: string): string {
  const body = raw.slice(1, -1);
  if (!body.includes("\\")) return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i] as string;
    if (e !== "u") {
      out += GROQ_ESCAPES[e] ?? "undefined";
    } else if (body[i + 1] === "{") {
      const close = body.indexOf("}", i);
      out += String.fromCharCode(Number.parseInt(body.slice(i + 2, close), 16));
      i = close;
    } else {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    }
  }
  return out;
}

type Constant =
  | { type: "number"; data: number }
  | { type: "string"; data: string }
  | { type: "other"; data: unknown }
  | { type: "null"; data: null };

const NULL: Constant = { type: "null", data: null };

function canConstantEvaluate(node: GroqNode): boolean {
  switch (node.type) {
    case "Group":
    case "Pos":
    case "Neg":
      return canConstantEvaluate(node["base"] as GroqNode);
    case "Value":
    case "Parameter":
      return true;
    case "OpCall":
      return (
        ["+", "-", "*", "/", "%", "**"].includes(node["op"] as string) &&
        canConstantEvaluate(node["left"] as GroqNode) &&
        canConstantEvaluate(node["right"] as GroqNode)
      );
    default:
      return false;
  }
}

const fromNumber = (n: number): Constant =>
  Number.isFinite(n) ? { type: "number", data: n } : NULL;

function constantEvaluate(node: GroqNode): Constant {
  switch (node.type) {
    case "Value": {
      const value = node["value"];
      if (typeof value === "number") return fromNumber(value);
      if (typeof value === "string") return { type: "string", data: value };
      return value === null || value === undefined ? NULL : { type: "other", data: value };
    }
    case "Group":
      return constantEvaluate(node["base"] as GroqNode);
    case "Pos":
    case "Neg": {
      const base = constantEvaluate(node["base"] as GroqNode);
      if (base.type !== "number") return NULL;
      return fromNumber(node.type === "Neg" ? -base.data : base.data);
    }
    case "OpCall": {
      const left = constantEvaluate(node["left"] as GroqNode);
      const right = constantEvaluate(node["right"] as GroqNode);
      const op = node["op"];
      if (op === "+" && left.type === "string" && right.type === "string") {
        return { type: "string", data: left.data + right.data };
      }
      if (left.type !== "number" || right.type !== "number") {
        // Arrays and objects concatenate under +, but no literal produces them here.
        return op === "+" && left.type === "other" && right.type === "other"
          ? { type: "other", data: null }
          : NULL;
      }
      switch (op) {
        case "+":
          return fromNumber(left.data + right.data);
        case "-":
          return fromNumber(left.data - right.data);
        case "*":
          return fromNumber(left.data * right.data);
        case "/":
          return fromNumber(left.data / right.data);
        case "%":
          return fromNumber(left.data % right.data);
        case "**":
          return fromNumber(left.data ** right.data);
        default:
          return NULL;
      }
    }
    default:
      return NULL;
  }
}

/** groq-js `tryConstantEvaluate`, reduced to what bracket and slice classification needs. */
export function tryConstantEvaluate(node: GroqNode): Constant | null {
  return canConstantEvaluate(node) ? constantEvaluate(node) : null;
}

const KEY_TRANSPARENT = new Set([
  "PipeFuncCall",
  "Deref",
  "Map",
  "FlatMap",
  "Projection",
  "Slice",
  "Filter",
  "AccessElement",
  "ArrayCoerce",
  "Group",
]);

/** groq-js `extractPropertyKey`: the implicit key of an object member, or undefined (a groq-js error). */
export function implicitKey(node: GroqNode): string | undefined {
  for (let current = node; ; current = current["base"] as GroqNode) {
    if (current.type === "AccessAttribute" && !current["base"]) return current["name"] as string;
    if (!KEY_TRANSPARENT.has(current.type)) return undefined;
  }
}

/** Whether the base of a traversal chain makes groq-js treat the whole chain as an array traversal. */
export const isArrayBase = (node: Node): boolean =>
  node.type === "Everything" || node.type === "Array" || node.type === "Pipe";

/** The traversal operators applied to a chain's base, innermost first, and that base. */
export function traversalChain(node: TraversalNode): { base: Node; ops: TraversalNode[] } {
  const ops: TraversalNode[] = [];
  let current: Node = node;
  while (isTraversal(current)) {
    ops.push(current);
    current = current.base;
  }
  ops.reverse();
  return { base: current, ops };
}

export class GroqTreeBuilder {
  private readonly functions = new Map<string, FunctionDeclaration>();
  private readonly scopes: Map<string, GroqNode>[] = [];

  constructor(
    functions: readonly FunctionDeclaration[] = [],
    private readonly options: GroqTreeOptions = {},
  ) {
    for (const fn of functions) this.functions.set(`${fn.namespace}::${fn.name}`, fn);
  }

  convert(node: Node): GroqNode {
    const opaque = this.options.opaque?.(node);
    if (opaque) return opaque;
    switch (node.type) {
      case "Everything":
        return { type: "Everything" };
      case "This":
        return { type: "This" };
      case "Parent":
        return { type: "Parent", n: node.levels };
      case "Identifier":
        if (node.name === "null") return { type: "Value", value: null };
        if (node.name === "true") return { type: "Value", value: true };
        if (node.name === "false") return { type: "Value", value: false };
        return { type: "AccessAttribute", name: node.name };
      case "String":
        return { type: "Value", value: groqJsStringValue(node.raw) };
      case "Number":
        return { type: "Value", value: Number(node.raw) };
      case "Parameter":
        return this.scopes.at(-1)?.get(node.name) ?? { type: "Parameter", name: node.name };
      case "Group":
        return { type: "Group", base: this.convert(node.expr) };
      case "Tuple":
        return { type: "Tuple", members: node.members.map((m) => this.convert(m)) };
      case "Array":
        return {
          type: "Array",
          elements: node.elements.map((e) => ({
            type: "ArrayElement",
            value: this.convert(e.value),
            isSplat: e.splat,
          })),
        };
      case "Object":
        return this.object(node);
      case "Prefix": {
        const type = node.op === "-" ? "Neg" : node.op === "+" ? "Pos" : "Not";
        return { type, base: this.convert(node.expr) };
      }
      case "Binary": {
        const left = this.convert(node.left);
        const right = this.convert(node.right);
        if (node.op === "||") return { type: "Or", left, right };
        if (node.op === "&&") return { type: "And", left, right };
        return { type: "OpCall", op: node.op, left, right };
      }
      case "InRange":
        return {
          type: "InRange",
          base: this.convert(node.left),
          left: this.convert(node.low),
          right: this.convert(node.high),
          isInclusive: !node.exclusive,
        };
      case "Pair":
        throw new GroqTreeError("unexpected =>");
      case "Order":
        throw new GroqTreeError(`unexpected ${node.direction}`);
      case "Call":
        return this.call(node);
      case "Pipe":
        return {
          type: "PipeFuncCall",
          base: this.convert(node.base),
          name: node.call.name,
          args: node.call.args.map((arg) =>
            node.call.name === "order" && arg.type === "Order"
              ? { type: arg.direction === "asc" ? "Asc" : "Desc", base: this.convert(arg.expr) }
              : this.convert(arg),
          ),
        };
      default:
        return this.chain(node);
    }
  }

  private object(node: ObjectLiteral): GroqNode {
    const attributes = node.members.map((member) => {
      switch (member.type) {
        case "Keyed":
          return {
            type: "ObjectAttributeValue",
            name: groqJsStringValue(member.key.raw),
            value: this.convert(member.value),
          };
        case "Spread":
          return { type: "ObjectSplat", value: member.value ? this.convert(member.value) : THIS };
        case "Expression": {
          if (member.value.type === "Pair") {
            return {
              type: "ObjectConditionalSplat",
              condition: this.convert(member.value.left),
              value: this.convert(member.value.right),
            };
          }
          const value = this.convert(member.value);
          const name = implicitKey(value);
          if (name === undefined) {
            throw new GroqTreeError(`cannot determine property key for type: ${value.type}`);
          }
          return { type: "ObjectAttributeValue", name, value };
        }
      }
    });
    return { type: "Object", attributes };
  }

  private call(node: Extract<Node, { type: "Call" }>): GroqNode {
    const namespace = node.namespace ?? "global";
    if (namespace === "global" && node.name === "select") {
      const alternatives: GroqNode[] = [];
      let fallback: GroqNode | undefined;
      for (const arg of node.args) {
        if (fallback) throw new GroqTreeError("unexpected argument to select()");
        if (arg.type === "Pair") {
          alternatives.push({
            type: "SelectAlternative",
            condition: this.convert(arg.left),
            value: this.convert(arg.right),
          });
        } else {
          fallback = this.convert(arg);
        }
      }
      return fallback
        ? { type: "Select", alternatives, fallback }
        : { type: "Select", alternatives };
    }
    const args = node.args.map((arg) => this.convert(arg));
    const fn = this.functions.get(`${namespace}::${node.name}`);
    if (!fn) return { type: "FuncCall", namespace, name: node.name, args };
    if (fn.params.length !== 1 || args.length !== 1) {
      throw new GroqTreeError(`custom function ${namespace}::${node.name} takes one argument`);
    }
    if (this.scopes.length > this.functions.size) {
      throw new GroqTreeError(
        `recursive function definition detected for ${namespace}::${node.name}`,
      );
    }
    this.scopes.push(new Map([[fn.params[0] as string, args[0] as GroqNode]]));
    try {
      return this.convert(fn.body);
    } finally {
      this.scopes.pop();
    }
  }

  private chain(node: TraversalNode): GroqNode {
    const { base, ops } = traversalChain(node);
    let traversal: Traversal | null = null;
    for (let i = ops.length - 1; i >= 0; i--)
      traversal = this.traverse(ops[i] as TraversalNode, traversal);
    if (isArrayBase(base)) traversal = traverseArray((value) => value, traversal);
    return (traversal as Traversal).build(this.convert(base));
  }

  private traverse(op: TraversalNode, right: Traversal | null): Traversal {
    switch (op.type) {
      case "Attribute":
        return traversePlain((base) => ({ type: "AccessAttribute", base, name: op.name }), right);
      case "Bracket": {
        const expr = this.convert(op.expr);
        const value = tryConstantEvaluate(expr);
        if (value?.type === "number") {
          return traverseElement(
            (base) => ({ type: "AccessElement", base, index: value.data }),
            right,
          );
        }
        if (value?.type === "string") {
          return traversePlain(
            (base) => ({ type: "AccessAttribute", base, name: value.data }),
            right,
          );
        }
        return traverseArray((base) => ({ type: "Filter", base, expr }), right);
      }
      case "Slice": {
        const low = tryConstantEvaluate(this.convert(op.low));
        const high = tryConstantEvaluate(this.convert(op.high));
        if (low?.type !== "number" || high?.type !== "number") {
          throw new GroqTreeError("slicing must use constant numbers");
        }
        return traverseArray(
          (base) => ({
            type: "Slice",
            base,
            left: low.data,
            right: high.data,
            isInclusive: !op.exclusive,
          }),
          right,
        );
      }
      case "Projection": {
        // The object is reached without `convert`, so consult the opaque hook here too.
        const expr = this.options.opaque?.(op.object) ?? this.object(op.object);
        return traverseProjection((base) => ({ type: "Projection", base, expr }), right);
      }
      case "Deref": {
        const attr = op.attr;
        return traversePlain((base) => {
          const deref: GroqNode = { type: "Deref", base };
          return attr === null ? deref : { type: "AccessAttribute", base: deref, name: attr };
        }, right);
      }
      case "ArrayPostfix":
        return traverseArray((base) => ({ type: "ArrayCoerce", base }), right);
    }
  }
}

/** The groq-js tree of a whole program, with custom functions expanded as groq-js does. */
export function groqTree(program: Program, options: GroqTreeOptions = {}): GroqNode {
  return new GroqTreeBuilder(program.functions, options).convert(program.body);
}
