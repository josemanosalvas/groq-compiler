// Prints a syntax tree as minimal text: every token in order, separated only where the minifier would need a
// space. Printing a freshly parsed query therefore reproduces its minified tokens.
import type { Call, FunctionDeclaration, Node, ObjectLiteral, Program } from "./ast.js";
import { joinTokens } from "./lexer.js";

/** Collects the tokens of nodes; callers may emit extra tokens between nodes (function declarations). */
export class TokenWriter {
  readonly tokens: string[] = [];

  /** Hook for printing a node differently (used by passes that rewrite while printing). */
  constructor(private readonly override?: (node: Node, writer: TokenWriter) => boolean) {}

  push(...tokens: string[]): void {
    for (const token of tokens) this.tokens.push(token);
  }

  node(node: Node): void {
    if (this.override?.(node, this)) return;
    const out = this.tokens;
    switch (node.type) {
      case "Everything":
        out.push("*");
        return;
      case "This":
        out.push("@");
        return;
      case "Parent":
        out.push("^");
        for (let i = 1; i < node.levels; i++) out.push(".", "^");
        return;
      case "Identifier":
        out.push(node.name);
        return;
      case "String":
      case "Number":
        out.push(node.raw);
        return;
      case "Parameter":
        out.push("$", node.name);
        return;
      case "Group":
        out.push("(");
        this.node(node.expr);
        out.push(")");
        return;
      case "Tuple":
        out.push("(");
        this.list(node.members);
        out.push(")");
        return;
      case "Array":
        out.push("[");
        node.elements.forEach((element, i) => {
          if (i > 0) out.push(",");
          if (element.splat) out.push("...");
          this.node(element.value);
        });
        if (node.trailingComma) out.push(",");
        out.push("]");
        return;
      case "Object":
        this.object(node);
        return;
      case "Prefix":
        out.push(node.op);
        this.node(node.expr);
        return;
      case "Binary":
        this.node(node.left);
        out.push(node.op);
        if (node.parens) out.push("(");
        this.node(node.right);
        if (node.parens) out.push(")");
        return;
      case "InRange":
        this.node(node.left);
        out.push("in");
        if (node.parens) out.push("(");
        this.node(node.low);
        out.push(node.exclusive ? "..." : "..");
        this.node(node.high);
        if (node.parens) out.push(")");
        return;
      case "Pair":
        this.node(node.left);
        out.push("=>");
        this.node(node.right);
        return;
      case "Order":
        this.node(node.expr);
        out.push(node.direction);
        return;
      case "Call":
        this.call(node);
        return;
      case "Pipe":
        this.node(node.base);
        out.push("|");
        this.call(node.call);
        return;
      case "Attribute":
        this.node(node.base);
        out.push(".", node.name);
        return;
      case "Bracket":
        this.node(node.base);
        out.push("[");
        this.node(node.expr);
        out.push("]");
        return;
      case "Slice":
        this.node(node.base);
        out.push("[");
        this.node(node.low);
        out.push(node.exclusive ? "..." : "..");
        this.node(node.high);
        out.push("]");
        return;
      case "ArrayPostfix":
        this.node(node.base);
        out.push("[", "]");
        return;
      case "Projection":
        this.node(node.base);
        if (node.pipe) out.push("|");
        this.object(node.object);
        return;
      case "Deref":
        this.node(node.base);
        out.push("->");
        if (node.attr !== null) out.push(node.attr);
        return;
    }
  }

  object(node: ObjectLiteral): void {
    const out = this.tokens;
    out.push("{");
    node.members.forEach((member, i) => {
      if (i > 0) out.push(",");
      switch (member.type) {
        case "Keyed":
          out.push(member.key.raw, ":");
          this.node(member.value);
          break;
        case "Expression":
          this.node(member.value);
          break;
        case "Spread":
          out.push("...");
          if (member.value) this.node(member.value);
          break;
      }
    });
    if (node.trailingComma) out.push(",");
    out.push("}");
  }

  call(node: Call): void {
    if (node.namespace !== null) this.tokens.push(node.namespace, "::");
    this.tokens.push(node.name, "(");
    this.list(node.args);
    if (node.trailingComma) this.tokens.push(",");
    this.tokens.push(")");
  }

  declaration(fn: FunctionDeclaration): void {
    const out = this.tokens;
    out.push("fn", fn.namespace, "::", fn.name, "(");
    fn.params.forEach((param, i) => {
      if (i > 0) out.push(",");
      out.push("$", param);
    });
    out.push(")", "=");
    this.node(fn.body);
    out.push(";");
  }

  program(program: Program): void {
    for (const fn of program.functions) this.declaration(fn);
    this.node(program.body);
  }

  private list(nodes: readonly Node[]): void {
    nodes.forEach((node, i) => {
      if (i > 0) this.tokens.push(",");
      this.node(node);
    });
  }

  toString(): string {
    return joinTokens(this.tokens);
  }
}

/** Minimal text of a program or a single expression. */
export function print(tree: Program | Node): string {
  const writer = new TokenWriter();
  if ("functions" in tree) writer.program(tree);
  else writer.node(tree);
  return writer.toString();
}
