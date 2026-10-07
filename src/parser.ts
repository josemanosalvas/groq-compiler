// Recursive-descent parser for GROQ revision 3 plus Sanity's extensions. Operator precedence and
// associativity follow groq-js 2.0.0 (the oracle) level for level, so every tree this parser builds has the
// structure groq-js gives the same text. Where groq-js deviates from the specification on plain syntax
// (whitespace before a call's parenthesis), this parser follows the specification.
import type {
  ArrayElement,
  BinaryOperator,
  Call,
  FunctionDeclaration,
  Node,
  ObjectLiteral,
  ObjectMember,
  Program,
  StringLiteral,
} from "./ast.js";
import { tokenize, utf8Length, type Token } from "./lexer.js";

export type ParseErrorKind = "syntax" | "unsupported";

/** Input the parser cannot turn into a tree: invalid GROQ, or valid GROQ this compiler does not model. */
export class ParseError extends Error {
  override name = "ParseError";

  constructor(
    message: string,
    /** UTF-16 offset of the offending token. */
    readonly position: number,
    /** Zero-based UTF-8 byte offset of the offending token. */
    readonly byteOffset: number,
    readonly kind: ParseErrorKind = "syntax",
  ) {
    super(`${message} at UTF-8 byte offset ${byteOffset}`);
  }
}

// Precedence levels, as in groq-js's raw parser.
const PREC_PAIR = 1;
const PREC_OR = 2;
const PREC_AND = 3;
const PREC_COMP = 4;
const PREC_ORDER = 4;
const PREC_ADD = 6;
const PREC_MUL = 7;
const PREC_POW = 8;
const PREC_NEG = 8;
const PREC_POS = 10;
const PREC_NOT = 10;
const PREC_PIPE = 11;
const PREC_PRIMARY = 12;

const NUMBER = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = {
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

/** Decodes a string literal already validated by the lexer. */
export function decodeString(raw: string): string {
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
      out += ESCAPES[e];
      continue;
    }
    if (body[i + 1] === "{") {
      const close = body.indexOf("}", i);
      out += String.fromCodePoint(Number.parseInt(body.slice(i + 2, close), 16));
      i = close;
    } else {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    }
  }
  return out;
}

class Parser {
  private index = 0;
  private readonly eof: Token;

  constructor(
    private readonly tokens: Token[],
    query: string,
    byteLength: number,
  ) {
    this.eof = {
      kind: "punctuator",
      text: "",
      start: query.length,
      end: query.length,
      byteStart: byteLength,
      byteEnd: byteLength,
      spaceBefore: false,
    };
  }

  private peek(offset = 0): Token {
    return this.tokens[this.index + offset] ?? this.eof;
  }

  private next(): Token {
    const token = this.peek();
    if (token !== this.eof) this.index++;
    return token;
  }

  private is(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token !== this.eof && token.text === text && token.kind !== "string";
  }

  private fail(message: string, token = this.peek(), kind: ParseErrorKind = "syntax"): never {
    throw new ParseError(message, token.start, token.byteStart, kind);
  }

  private expect(text: string): Token {
    if (!this.is(text)) {
      const found = this.peek();
      this.fail(
        `expected "${text}" but found ${found === this.eof ? "end of query" : `"${found.text}"`}`,
      );
    }
    return this.next();
  }

  private identifier(what: string): Token {
    if (this.peek().kind !== "identifier") this.fail(`expected ${what}`);
    return this.next();
  }

  private get lastEnd(): number {
    return this.tokens[this.index - 1]?.end ?? 0;
  }

  parseProgram(): Program {
    const functions: FunctionDeclaration[] = [];
    while (this.is("fn") && this.peek(1).kind === "identifier") {
      functions.push(this.parseFunctionDeclaration());
    }
    const body = this.parseExpr(0);
    if (this.peek() !== this.eof) this.fail(`unexpected "${this.peek().text}"`);
    return { functions, body, start: functions[0]?.start ?? body.start, end: body.end };
  }

  private parseFunctionDeclaration(): FunctionDeclaration {
    const start = this.next().start;
    const namespace = this.identifier("a function namespace").text;
    this.expect("::");
    const name = this.identifier("a function name").text;
    this.expect("(");
    const params: string[] = [];
    while (!this.is(")")) {
      this.expect("$");
      if (this.peek().spaceBefore) this.fail("expected a parameter name directly after $");
      params.push(this.identifier("a parameter name").text);
      if (!this.is(",")) break;
      this.next();
    }
    this.expect(")");
    this.expect("=");
    const body = this.parseExpr(0);
    this.expect(";");
    return { namespace, name, params, body, start, end: this.lastEnd };
  }

  /** groq-js `parseExpr`: `level` is the minimum precedence to parse, `lhsLevel` that of the left side. */
  parseExpr(level: number): Node {
    let left = this.parsePrimary();
    const start = left.start;
    let lhsLevel = PREC_PRIMARY;
    for (;;) {
      const token = this.peek();
      if (token === this.eof || token.kind === "string" || token.kind === "number") break;
      const traversed = this.parseTraversal(left);
      if (traversed) {
        left = traversed;
        continue;
      }
      const text = token.text;
      switch (text) {
        case "=>": {
          if (level > PREC_PAIR || lhsLevel <= PREC_PAIR) return left;
          this.next();
          const right = this.parseExpr(PREC_PAIR);
          left = { type: "Pair", left, right, start, end: right.end };
          lhsLevel = PREC_PAIR;
          continue;
        }
        case "==":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "match": {
          if (text === "match" && token.kind !== "identifier") return left;
          if (level > PREC_COMP || lhsLevel <= PREC_COMP) return left;
          this.next();
          const right = this.parseExpr(PREC_COMP + 1);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_COMP;
          continue;
        }
        case "in": {
          if (level > PREC_COMP || lhsLevel <= PREC_COMP) return left;
          this.next();
          left = this.parseIn(left, start);
          lhsLevel = PREC_COMP;
          continue;
        }
        case "+":
        case "-": {
          if (level > PREC_ADD || lhsLevel < PREC_ADD) return left;
          this.next();
          const right = this.parseExpr(PREC_ADD + 1);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_ADD;
          continue;
        }
        case "*":
        case "/":
        case "%": {
          if (level > PREC_MUL || lhsLevel < PREC_MUL) return left;
          this.next();
          const right = this.parseExpr(PREC_MUL + 1);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_MUL;
          continue;
        }
        case "**": {
          if (level > PREC_POW || lhsLevel <= PREC_POW) return left;
          this.next();
          const right = this.parseExpr(PREC_POW);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_POW;
          continue;
        }
        case "||": {
          if (level > PREC_OR || lhsLevel < PREC_OR) return left;
          this.next();
          const right = this.parseExpr(PREC_OR + 1);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_OR;
          continue;
        }
        case "&&": {
          if (level > PREC_AND || lhsLevel < PREC_AND) return left;
          this.next();
          const right = this.parseExpr(PREC_AND + 1);
          left = this.binary(text, left, right, start);
          lhsLevel = PREC_AND;
          continue;
        }
        case "|": {
          if (level > PREC_PIPE || lhsLevel < PREC_PIPE) return left;
          this.next();
          const call = this.parsePipeCall();
          left = { type: "Pipe", base: left, call, start, end: call.end };
          lhsLevel = PREC_PIPE;
          continue;
        }
        case "asc":
        case "desc": {
          if (token.kind !== "identifier") return left;
          if (level > PREC_ORDER || lhsLevel < PREC_ORDER) return left;
          this.next();
          left = { type: "Order", expr: left, direction: text, start, end: token.end };
          lhsLevel = PREC_ORDER;
          continue;
        }
        default:
          return left;
      }
    }
    return left;
  }

  private binary(op: string, left: Node, right: Node, start: number): Node {
    return {
      type: "Binary",
      op: op as BinaryOperator,
      left,
      right,
      parens: false,
      start,
      end: right.end,
    };
  }

  /** After `in`: a range `low..high` or an expression, optionally inside parentheses that groq-js consumes. */
  private parseIn(left: Node, start: number): Node {
    const parens = this.is("(");
    if (parens) this.next();
    const operand = this.parseExpr(PREC_COMP + 1);
    let node: Node;
    if (this.is("..") || this.is("...")) {
      const exclusive = this.next().text === "...";
      const high = this.parseExpr(PREC_COMP + 1);
      node = { type: "InRange", left, low: operand, high, exclusive, parens, start, end: high.end };
    } else {
      node = { type: "Binary", op: "in", left, right: operand, parens, start, end: operand.end };
    }
    if (parens) {
      this.expect(")");
      node.end = this.lastEnd;
    }
    return node;
  }

  /** One traversal operator applied to `base`, or undefined when the next token does not start one. */
  private parseTraversal(base: Node): Node | undefined {
    const token = this.peek();
    const start = base.start;
    switch (token.text) {
      case ".": {
        if (token.kind !== "punctuator") return undefined;
        if (this.is("(", 1))
          this.fail("selector traversals are not supported", token, "unsupported");
        if (this.peek(1).kind !== "identifier") return undefined;
        this.next();
        const name = this.next();
        return { type: "Attribute", base, name: name.text, start, end: name.end };
      }
      case "->": {
        this.next();
        if (this.peek().kind === "identifier") {
          const attr = this.next();
          return { type: "Deref", base, attr: attr.text, start, end: attr.end };
        }
        return { type: "Deref", base, attr: null, start, end: token.end };
      }
      case "[": {
        this.next();
        if (this.is("]")) {
          const close = this.next();
          return { type: "ArrayPostfix", base, start, end: close.end };
        }
        const expr = this.parseExpr(0);
        if (this.is("..") || this.is("...")) {
          const exclusive = this.next().text === "...";
          const high = this.parseExpr(0);
          const close = this.expect("]");
          return { type: "Slice", base, low: expr, high, exclusive, start, end: close.end };
        }
        const close = this.expect("]");
        return { type: "Bracket", base, expr, start, end: close.end };
      }
      case "{": {
        const object = this.parseObject();
        return { type: "Projection", base, object, pipe: false, start, end: object.end };
      }
      case "|": {
        if (!this.is("{", 1)) return undefined;
        this.next();
        const object = this.parseObject();
        return { type: "Projection", base, object, pipe: true, start, end: object.end };
      }
      default:
        return undefined;
    }
  }

  private parsePrimary(): Node {
    const token = this.peek();
    const start = token.start;
    if (token === this.eof) this.fail("expected an expression");
    switch (token.kind) {
      case "string": {
        this.next();
        return this.string(token);
      }
      case "number": {
        this.next();
        if (!NUMBER.test(token.text)) this.fail(`invalid number "${token.text}"`, token);
        return {
          type: "Number",
          raw: token.text,
          value: Number(token.text),
          start,
          end: token.end,
        };
      }
      case "identifier":
        return this.parseIdentifier();
      default:
        break;
    }
    switch (token.text) {
      case "+":
      case "-":
      case "!": {
        this.next();
        const expr = this.parseExpr(
          token.text === "-" ? PREC_NEG : token.text === "+" ? PREC_POS : PREC_NOT,
        );
        return { type: "Prefix", op: token.text, expr, start, end: expr.end };
      }
      case "(": {
        this.next();
        const first = this.parseExpr(0);
        if (this.is(",")) {
          const members = [first];
          while (this.is(",")) {
            this.next();
            members.push(this.parseExpr(0));
          }
          const close = this.expect(")");
          return { type: "Tuple", members, start, end: close.end };
        }
        const close = this.expect(")");
        return { type: "Group", expr: first, start, end: close.end };
      }
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case "^": {
        this.next();
        let levels = 1;
        while (this.is(".") && this.is("^", 1)) {
          this.next();
          this.next();
          levels++;
        }
        return { type: "Parent", levels, start, end: this.lastEnd };
      }
      case "@":
        this.next();
        return { type: "This", start, end: token.end };
      case "*":
        this.next();
        return { type: "Everything", start, end: token.end };
      case "$": {
        this.next();
        const name = this.peek();
        if (name.kind !== "identifier" || name.spaceBefore)
          this.fail("expected a parameter name directly after $");
        this.next();
        return { type: "Parameter", name: name.text, start, end: name.end };
      }
      default:
        return this.fail(`unexpected "${token.text}"`);
    }
  }

  private string(token: Token): StringLiteral {
    return {
      type: "String",
      raw: token.text,
      value: decodeString(token.text),
      start: token.start,
      end: token.end,
    };
  }

  private parseIdentifier(): Node {
    const token = this.next();
    const start = token.start;
    if (this.is("::") && this.peek(1).kind === "identifier") {
      this.next();
      const name = this.next();
      if (!this.is("(")) this.fail("expected ( after a namespaced function name");
      return this.parseCallArguments(token.text, name.text, start);
    }
    if (this.is("(")) return this.parseCallArguments(null, token.text, start);
    return { type: "Identifier", name: token.text, start, end: token.end };
  }

  private parseCallArguments(namespace: string | null, name: string, start: number): Call {
    this.expect("(");
    const args: Node[] = [];
    let trailingComma = false;
    while (!this.is(")")) {
      args.push(this.parseExpr(0));
      if (!this.is(",")) break;
      this.next();
      trailingComma = this.is(")");
    }
    const close = this.expect(")");
    return { type: "Call", namespace, name, args, trailingComma, start, end: close.end };
  }

  private parsePipeCall(): Call {
    const name = this.identifier("a pipe function name");
    if (this.is("::") && this.peek(1).kind === "identifier") {
      this.next();
      const inner = this.next();
      return this.parseCallArguments(name.text, inner.text, name.start);
    }
    if (!this.is("(")) this.fail("expected ( after a pipe function name");
    return this.parseCallArguments(null, name.text, name.start);
  }

  private parseObject(): ObjectLiteral {
    const open = this.expect("{");
    const members: ObjectMember[] = [];
    let trailingComma = false;
    while (!this.is("}")) {
      const token = this.peek();
      if (this.is("...")) {
        this.next();
        const value = this.is("}") || this.is(",") ? null : this.parseExpr(0);
        members.push({ type: "Spread", value, start: token.start, end: value?.end ?? token.end });
      } else {
        const value = this.parseExpr(0);
        if (value.type === "String" && this.is(":")) {
          this.next();
          const inner = this.parseExpr(0);
          members.push({
            type: "Keyed",
            key: value,
            value: inner,
            start: value.start,
            end: inner.end,
          });
        } else {
          members.push({ type: "Expression", value, start: value.start, end: value.end });
        }
      }
      if (!this.is(",")) break;
      this.next();
      trailingComma = this.is("}");
    }
    const close = this.expect("}");
    return { type: "Object", members, trailingComma, start: open.start, end: close.end };
  }

  private parseArray(): Node {
    const open = this.expect("[");
    const elements: ArrayElement[] = [];
    let trailingComma = false;
    while (!this.is("]")) {
      const token = this.peek();
      const splat = this.is("...");
      if (splat) this.next();
      const value = this.parseExpr(0);
      elements.push({ value, splat, start: token.start, end: value.end });
      if (!this.is(",")) break;
      this.next();
      trailingComma = this.is("]");
    }
    const close = this.expect("]");
    return { type: "Array", elements, trailingComma, start: open.start, end: close.end };
  }
}

/**
 * Parses a GROQ query into a syntax tree.
 * @throws {TypeError} Non-string input or unpaired UTF-16 surrogates.
 * @throws {SyntaxError} Unterminated strings and invalid escapes (the minifier's errors).
 * @throws {ParseError} Any other invalid or unsupported syntax.
 */
export function parse(query: string): Program {
  const tokens = tokenize(query);
  return new Parser(tokens, query, utf8Length(query)).parseProgram();
}
