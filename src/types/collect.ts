// Finds the object type literals inside a file's top-level declarations and gives each a shape: literals
// with the same canonical key have the same shape, and the same key means the same type. The key is the
// literal's tokens without whitespace or comments, with nested literals replaced by their shape number, so
// every key is computed in one pass over the tree. Formatting-only differences are normalized: member
// separators, a leading `|` or `&`, trailing commas, quotes around property names and string literals.
// Property order is kept, so literals that differ only in member order are different shapes.
import type * as TS from "typescript";
import type { TypeScriptApi } from "./api.js";
import type { PathSegment } from "./names.js";

/** Kept in place; nested replacements still apply. */
export const KEEP = 0;
/** Replaced by a name; the copy and everything in it disappears. */
export const REPLACED = 1;
/** Replaced by the alias name; the copy becomes the alias body. */
export const REPRESENTATIVE = 2;
export type State = typeof KEEP | typeof REPLACED | typeof REPRESENTATIVE;

export interface Occurrence {
  /** Offsets of `{` and just after `}`. */
  readonly start: number;
  readonly end: number;
  /** Enclosing occurrence, or -1. */
  readonly parent: number;
  readonly children: number[];
  /** Index of the top-level statement. */
  readonly statement: number;
  /** The whole type of a type alias declaration: stays in place, and copies elsewhere may use its name. */
  readonly topLevel: boolean;
  /** Property path; for a top-level occurrence, the declaration name. */
  readonly path: PathSegment;
  /** Not inside a construct that binds names (mapped and conditional types, signatures) or uses `this`. */
  movable: boolean;
  /** Contains a multi-line template literal, so its lines must not be re-indented. */
  verbatim: boolean;
  shape: number;
  state: State;
  /** Name that replaces the occurrence (when not kept). */
  name: string;
}

export interface Shape {
  /** Length of the canonical key with nested shapes expanded: a size estimate without indentation. */
  readonly size: number;
  /** Value of a `_type: "…"` property. */
  readonly typeName: string | undefined;
  /** Occurrences in source order. */
  readonly occurrences: number[];
}

export class Collector {
  /** In source order of their start; children always follow their parent. */
  readonly occurrences: Occurrence[] = [];
  readonly shapes: Shape[] = [];
  private readonly keys = new Map<string, number>();
  private readonly scanner: TS.Scanner;
  private readonly SK: typeof TS.SyntaxKind;
  private parent = -1;
  private statement = -1;
  private binders = 0;
  private path: PathSegment = { name: "", parent: undefined };
  /** Expanded size minus placeholder length of the nested shapes seen in the current literal. */
  private extra = 0;

  constructor(
    private readonly ts: TypeScriptApi,
    private readonly file: TS.SourceFile,
  ) {
    this.SK = ts.SyntaxKind;
    this.scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard);
  }

  /** Records non-generic type aliases and interfaces; other statements are left alone. */
  collect(): this {
    const { ts } = this;
    this.file.statements.forEach((statement, index) => {
      this.statement = index;
      if (ts.isTypeAliasDeclaration(statement) && !statement.typeParameters) {
        this.path = { name: statement.name.text, parent: undefined };
        if (ts.isTypeLiteralNode(statement.type)) this.literal(statement.type, true);
        else this.canon(statement.type);
      } else if (ts.isInterfaceDeclaration(statement) && !statement.typeParameters) {
        this.path = { name: statement.name.text, parent: undefined };
        for (const member of statement.members) this.canon(member);
      }
    });
    return this;
  }

  /** Every identifier in the file: new names must not shadow or collide with any of them. */
  identifiers(): Set<string> {
    const { ts } = this;
    const names = new Set<string>();
    const visit = (node: TS.Node): void => {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(this.file);
    return names;
  }

  private canon(node: TS.Node): string {
    const { SK } = this;
    switch (node.kind) {
      case SK.TypeLiteral:
        return this.literal(node as TS.TypeLiteralNode, false);
      case SK.StringLiteral:
        return ` ${JSON.stringify((node as TS.StringLiteral).text)}`;
      case SK.PropertySignature:
        return this.property(node as TS.PropertySignature);
      case SK.UnionType:
        return this.list((node as TS.UnionTypeNode).types, " |");
      case SK.IntersectionType:
        return this.list((node as TS.IntersectionTypeNode).types, " &");
      case SK.ThisType:
        // `this` refers to the enclosing interface: nothing around it can move.
        this.mark((occurrence) => (occurrence.movable = false));
        return " this";
      case SK.NoSubstitutionTemplateLiteral:
      case SK.TemplateHead:
      case SK.TemplateMiddle:
      case SK.TemplateTail: {
        const text = node.getText(this.file);
        if (text.includes("\n")) this.mark((occurrence) => (occurrence.verbatim = true));
        return ` t${JSON.stringify(text)}`;
      }
      case SK.MappedType:
      case SK.ConditionalType:
      case SK.FunctionType:
      case SK.ConstructorType:
      case SK.MethodSignature:
      case SK.CallSignature:
      case SK.ConstructSignature: {
        // Literals inside may refer to the names these bind (type or value parameters).
        this.binders++;
        const text = this.generic(node);
        this.binders--;
        return text;
      }
      default:
        return this.generic(node);
    }
  }

  /** Children's keys with the punctuation between them; a leaf is its own text. */
  private generic(node: TS.Node): string {
    let out = "";
    let position = node.pos;
    let leaf = true;
    this.ts.forEachChild(node, (child) => {
      leaf = false;
      out += this.gap(position, child.pos) + this.canon(child);
      position = child.end;
    });
    if (leaf) return ` ${node.getText(this.file)}`;
    return out + this.gap(position, node.end);
  }

  private property(node: TS.PropertySignature): string {
    const { ts } = this;
    const saved = this.path;
    const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name : undefined;
    if (key) this.path = { name: key.text, parent: saved };
    let out = "";
    let position = node.pos;
    ts.forEachChild(node, (child) => {
      // `a`, `"a"` and `'a'` name the same property.
      const text = child === key ? ` ${JSON.stringify(key.text)}` : this.canon(child);
      out += this.gap(position, child.pos) + text;
      position = child.end;
    });
    this.path = saved;
    return out + this.gap(position, node.end);
  }

  private list(types: TS.NodeArray<TS.TypeNode>, operator: string): string {
    let out = "";
    types.forEach((type, index) => {
      if (index > 0) out += operator;
      out += this.canon(type);
    });
    return out;
  }

  private literal(node: TS.TypeLiteralNode, topLevel: boolean): string {
    const index = this.occurrences.length;
    const occurrence: Occurrence = {
      start: node.getStart(this.file),
      end: node.end,
      parent: this.parent,
      children: [],
      statement: this.statement,
      topLevel,
      path: this.path,
      movable: this.binders === 0,
      verbatim: false,
      shape: -1,
      state: KEEP,
      name: "",
    };
    this.occurrences.push(occurrence);
    if (this.parent >= 0) (this.occurrences[this.parent] as Occurrence).children.push(index);
    const savedParent = this.parent;
    const savedExtra = this.extra;
    this.parent = index;
    this.extra = 0;
    let key = "{";
    node.members.forEach((member, i) => {
      if (i > 0) key += ";";
      key += withoutSeparator(this.canon(member));
    });
    key += " }";
    const size = key.length + this.extra;
    this.parent = savedParent;
    let shape = this.keys.get(key);
    if (shape === undefined) {
      shape = this.shapes.length;
      this.keys.set(key, shape);
      this.shapes.push({ size, typeName: typeName(this.ts, node), occurrences: [] });
    }
    occurrence.shape = shape;
    (this.shapes[shape] as Shape).occurrences.push(index);
    // NUL occurs nowhere else in a key: string and template literals are JSON-escaped.
    const placeholder = ` \u0000${shape}`;
    this.extra = savedExtra + size - placeholder.length;
    return placeholder;
  }

  /** Tokens between two children, without trivia; a trailing comma before a closing bracket is dropped. */
  private gap(from: number, to: number): string {
    if (from >= to) return "";
    const { scanner, SK } = this;
    scanner.setText(this.file.text, from, to - from);
    let out = "";
    let comma = false;
    for (let kind = scanner.scan(); kind !== SK.EndOfFileToken; kind = scanner.scan()) {
      const closing =
        kind === SK.CloseBracketToken ||
        kind === SK.CloseParenToken ||
        kind === SK.GreaterThanToken ||
        kind === SK.CloseBraceToken;
      if (comma && !closing) out += " ,";
      comma = kind === SK.CommaToken;
      if (!comma) out += ` ${scanner.getTokenText()}`;
    }
    return comma ? `${out} ,` : out;
  }

  /** Updates the current literal and every literal around it. */
  private mark(update: (occurrence: Occurrence) => void): void {
    for (let p = this.parent; p >= 0;) {
      const occurrence = this.occurrences[p] as Occurrence;
      update(occurrence);
      p = occurrence.parent;
    }
  }
}

function withoutSeparator(member: string): string {
  return member.endsWith(" ;") || member.endsWith(" ,") ? member.slice(0, -2) : member;
}

/** Value of a `_type: "…"` property (Sanity's document or object type). */
function typeName(ts: TypeScriptApi, node: TS.TypeLiteralNode): string | undefined {
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const name = member.name;
    if (!(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== "_type") continue;
    const type = member.type;
    return ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
      ? type.literal.text
      : undefined;
  }
  return undefined;
}
