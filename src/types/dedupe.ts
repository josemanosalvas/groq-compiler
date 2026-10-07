// Emits each repeated object type literal of a TypeScript file (Sanity TypeGen's `sanity.types.ts`) once,
// as a named alias. Shapes are chosen largest first, so a container is always decided before the shapes
// inside it, and copies inside a replaced copy disappear with it. A chosen shape becomes a non-exported
// alias declared just before the statement that holds its first copy, or, when it is the whole type of an
// existing non-generic type alias, copies use that alias's name. A declaration's own type is never
// replaced, so exported names, their order and their types stay the same.
import type * as TS from "typescript";
import {
  Collector,
  KEEP,
  REPLACED,
  REPRESENTATIVE,
  type Occurrence,
  type Shape,
} from "./collect.js";
import { asTypeScript, resolveTypeScript, type TypeScriptApi } from "./api.js";
import type { TypeScriptModule } from "./load.js";
import { assignNames, baseName } from "./names.js";

export interface DedupeOptions {
  /** The `typescript` module (5.9 or 6). Loaded with `import("typescript")` when omitted. */
  readonly ts?: TypeScriptModule;
  /**
   * Smallest shape worth naming, in characters of its normalized text (tokens separated by one space,
   * without comments). Smaller repeated literals stay inline. Default 40.
   */
  readonly minSize?: number;
  /**
   * Replace copies of a literal that is the whole type of an existing type alias with that alias's name
   * (for example a projection identical to a schema type). Default `true`.
   */
  readonly reuseDeclarations?: boolean;
}

export interface DedupeAlias {
  /** Alias name (a non-exported type), or the name of the reused declaration. */
  readonly name: string;
  /** Places in the output that use the name. */
  readonly uses: number;
  /** UTF-8 bytes of the shape's text as declared. */
  readonly size: number;
}

export interface DedupeResult {
  readonly output: string;
  /** New aliases, in output order. */
  readonly aliases: readonly DedupeAlias[];
  /** Existing type aliases whose name replaced identical literals, in source order. */
  readonly reused: readonly DedupeAlias[];
  readonly stats: {
    readonly inputBytes: number;
    readonly outputBytes: number;
  };
}

/**
 * Emits each repeated object type literal once, as a named alias. Loads `typescript` unless `options.ts`
 * is given.
 * @throws {SyntaxError} The source does not parse.
 * @throws {Error} No TypeScript compiler API is available, or the source is not a module.
 */
export async function dedupeTypes(
  source: string,
  options: DedupeOptions = {},
): Promise<DedupeResult> {
  return dedupe(await resolveTypeScript(options.ts), source, options);
}

/** Synchronous {@link dedupeTypes}; `options.ts` is required. */
export function dedupeTypesSync(
  source: string,
  options: DedupeOptions & { readonly ts: TypeScriptModule },
): DedupeResult {
  return dedupe(asTypeScript(options.ts), source, options);
}

interface Alias {
  readonly representative: Occurrence;
  readonly sites: readonly Occurrence[];
  name: string;
}

const DEFAULT_MIN_SIZE = 40;
/** Estimated characters added to a base name: `Shape` and a qualifier or digit. */
const NAME_EXTRA = 8;
/** `type ` + ` = ` + `;` + blank line. */
const ALIAS_OVERHEAD = 11;

function dedupe(ts: TypeScriptApi, source: string, options: DedupeOptions): DedupeResult {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const file = ts.createSourceFile(
    "types.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  // Syntax errors are on `parseDiagnostics`, missing from the public typings but present in 5.x and 6.
  const diagnostic = (file as { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] })
    .parseDiagnostics?.[0];
  if (diagnostic) {
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new SyntaxError(`${message} (line ${line + 1}, column ${character + 1})`);
  }
  if (!ts.isExternalModule(file)) {
    throw new Error("The source is not a module, so new aliases would be global declarations");
  }

  const collector = new Collector(ts, file).collect();
  const { aliases, reused } = select(collector, source, options);
  const names = assignNames(
    aliases.map(({ representative }) => ({
      typeName: (collector.shapes[representative.shape] as Shape).typeName,
      path: representative.path,
      start: representative.start,
    })),
    collector.identifiers(),
  );
  aliases.forEach((alias, i) => {
    alias.name = names[i] as string;
    for (const site of alias.sites) site.name = alias.name;
  });
  const { output, declared } = emit(ts, file, collector.occurrences, aliases);
  return {
    output,
    aliases: declared,
    reused,
    stats: { inputBytes: utf8Length(source), outputBytes: utf8Length(output) },
  };
}

/** Decides which copies to replace; leaves alias names empty. */
function select(
  { occurrences, shapes }: Collector,
  source: string,
  options: DedupeOptions,
): { aliases: Alias[]; reused: DedupeAlias[] } {
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const reuse = options.reuseDeclarations ?? true;
  const isDead = (occurrence: Occurrence): boolean => {
    for (let p = occurrence.parent; p >= 0;) {
      const parent = occurrences[p] as Occurrence;
      if (parent.state === REPLACED) return true;
      p = parent.parent;
    }
    return false;
  };
  const order = shapes
    .filter((shape) => shape.occurrences.length > 1 && shape.size >= minSize)
    .toSorted((a, b) => b.size - a.size || firstOccurrence(a) - firstOccurrence(b));

  const aliases: Alias[] = [];
  const reused: Array<DedupeAlias & { start: number }> = [];
  for (const shape of order) {
    let declaration: Occurrence | undefined;
    const sites: Occurrence[] = [];
    for (const o of shape.occurrences) {
      const occurrence = occurrences[o] as Occurrence;
      if (isDead(occurrence)) continue;
      if (occurrence.topLevel) declaration ??= occurrence;
      else if (occurrence.movable) sites.push(occurrence);
    }
    if (declaration && reuse) {
      const name = declaration.path.name;
      if (sites.length === 0 || shape.size <= name.length) continue;
      for (const site of sites) {
        site.state = REPLACED;
        site.name = name;
      }
      const size = utf8Length(source.slice(declaration.start, declaration.end));
      reused.push({ name, uses: sites.length, size, start: declaration.start });
      continue;
    }
    const representative = sites[0];
    if (!representative || sites.length < 2) continue;
    const nameLength = baseName({ typeName: shape.typeName, path: representative.path }).length;
    const estimate = nameLength + NAME_EXTRA;
    const savings =
      (sites.length - 1) * shape.size - sites.length * estimate - estimate - ALIAS_OVERHEAD;
    if (savings <= 0) continue;
    for (const site of sites) site.state = REPLACED;
    representative.state = REPRESENTATIVE;
    aliases.push({ representative, sites, name: "" });
  }
  return {
    aliases,
    reused: reused
      .toSorted((a, b) => a.start - b.start)
      .map(({ name, uses, size }) => ({ name, uses, size })),
  };
}

function firstOccurrence(shape: Shape): number {
  return shape.occurrences[0] as number;
}

/** Writes the output: replaced copies become names; aliases go before the statement of their first copy. */
function emit(
  ts: TypeScriptApi,
  file: TS.SourceFile,
  occurrences: readonly Occurrence[],
  aliases: readonly Alias[],
): { output: string; declared: DedupeAlias[] } {
  const source = file.text;
  const site = (occurrence: Occurrence): string =>
    occurrence.state === KEEP ? inner(occurrence) : occurrence.name;
  const inner = (occurrence: Occurrence): string => {
    let out = "";
    let position = occurrence.start;
    for (const c of occurrence.children) {
      const child = occurrences[c] as Occurrence;
      out += source.slice(position, child.start) + site(child);
      position = child.end;
    }
    return out + source.slice(position, occurrence.end);
  };

  // Innermost first within a statement, so each alias is declared before the aliases that use it.
  const byStatement = new Map<number, Alias[]>();
  for (const alias of aliases.toSorted((a, b) => a.representative.end - b.representative.end)) {
    const statement = alias.representative.statement;
    const list = byStatement.get(statement);
    if (list) list.push(alias);
    else byStatement.set(statement, [alias]);
  }
  const roots = occurrences.filter((occurrence) => occurrence.parent === -1);
  const declared: DedupeAlias[] = [];
  let output = "";
  let cursor = 0;
  let root = 0;
  const copyUntil = (position: number): void => {
    for (; root < roots.length && (roots[root] as Occurrence).start < position; root++) {
      const occurrence = roots[root] as Occurrence;
      output += source.slice(cursor, occurrence.start) + site(occurrence);
      cursor = occurrence.end;
    }
    output += source.slice(cursor, position);
    cursor = position;
  };
  for (const statement of [...byStatement.keys()].toSorted((a, b) => a - b)) {
    const at = insertionPoint(ts, file, statement);
    copyUntil(at.position);
    const declarations = (byStatement.get(statement) as Alias[]).map(({ name, representative }) => {
      const text = inner(representative);
      const body = representative.verbatim
        ? text
        : outdent(text, indentation(source, representative));
      declared.push({ name, uses: 0, size: utf8Length(body) });
      return `type ${name} = ${body};`;
    });
    output += at.before + declarations.join("\n\n") + at.after;
  }
  copyUntil(source.length);
  const uses = new Map(aliases.map((alias) => [alias.name, alias.sites.length]));
  return {
    output,
    declared: declared.map((alias) => ({ ...alias, uses: uses.get(alias.name) ?? 0 })),
  };
}

/** Indentation of the closing brace's line when `}` starts it, else of the opening brace's line. */
function indentation(source: string, occurrence: Occurrence): string {
  const close = occurrence.end - 1;
  const closeLine = source.lastIndexOf("\n", close) + 1;
  const beforeClose = source.slice(closeLine, close);
  if (closeLine > occurrence.start && beforeClose.trim() === "") return beforeClose;
  const openLine = source.lastIndexOf("\n", occurrence.start) + 1;
  return /^[ \t]*/.exec(source.slice(openLine, occurrence.start))?.[0] ?? "";
}

/** Removes `prefix` from the start of every line but the first. */
function outdent(text: string, prefix: string): string {
  if (prefix === "" || !text.includes("\n")) return text;
  return text
    .split("\n")
    .map((line, i) => (i > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
}

/** Where aliases go before a statement, with the line breaks around them. */
function insertionPoint(
  ts: TypeScriptApi,
  file: TS.SourceFile,
  index: number,
): { position: number; before: string; after: string } {
  const text = file.text;
  const statement = file.statements[index] as TS.Statement;
  if (statement.pos > 0) {
    // After the previous statement and any comment on its last line.
    const trailing = ts.getTrailingCommentRanges(text, statement.pos);
    return { position: trailing?.at(-1)?.end ?? statement.pos, before: "\n\n", after: "" };
  }
  // The first statement: after the last leading comment followed by a blank line (a file header).
  const comments = ts.getLeadingCommentRanges(text, 0) ?? [];
  const start = statement.getStart(file);
  let position = -1;
  comments.forEach((comment, i) => {
    const next = comments[i + 1]?.pos ?? start;
    if (/\n[ \t\r]*\n/.test(text.slice(comment.end, next))) position = comment.end;
  });
  return position < 0
    ? { position: 0, before: "", after: "\n\n" }
    : { position, before: "\n\n", after: "" };
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
