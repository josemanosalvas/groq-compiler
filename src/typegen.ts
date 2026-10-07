// Reads the query registry that Sanity TypeGen writes at the end of `sanity.types.ts`:
//   declare global { interface SanityQueries { '<query>': <Name>Result; … } }
// TypeGen resolves `${fragment}` interpolation across files, so each key is the complete query text.

export interface RegistryQuery {
  /** The variable that holds the query (from TypeGen's `// Variable:` comment), else the result type name. */
  name: string;
  /** TypeGen's result type, e.g. `PageQueryResult`. */
  resultType: string;
  /** The query exactly as the application sends it. */
  query: string;
}

const SINGLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};

/** Reads the TypeScript string literal starting at `start`; returns its value and the index after it. */
export function readStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  if (quote !== "'" && quote !== '"')
    throw new SyntaxError(`expected a string literal at ${start}`);
  let value = "";
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i] as string;
    if (c === quote) return { value, end: i + 1 };
    if (c === "\n") break;
    if (c !== "\\") {
      value += c;
      continue;
    }
    const e = source[++i] as string;
    if (e in SINGLE_ESCAPES) value += SINGLE_ESCAPES[e];
    else if (e === "x") {
      value += String.fromCharCode(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === "u" && source[i + 1] === "{") {
      const close = source.indexOf("}", i);
      value += String.fromCodePoint(Number.parseInt(source.slice(i + 2, close), 16));
      i = close;
    } else if (e === "u") {
      value += String.fromCharCode(Number.parseInt(source.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (e === "\r") {
      if (source[i + 1] === "\n") i++; // line continuation
    } else if (e !== "\n" && e !== " " && e !== " ") {
      value += e;
    }
  }
  throw new SyntaxError(`unterminated string literal at ${start}`);
}

/** Maps result type names to the variables TypeGen names in `// Variable: x` comments. */
function variableNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern = /^\/\/ Variable: (\w+)\n(?:\/\/ .*\n)*export type (\w+)\s*=/gm;
  for (const [, variable, type] of source.matchAll(pattern))
    names.set(type as string, variable as string);
  return names;
}

/** Every query in a TypeGen `sanity.types.ts`, in registry order. Empty when the file has no registry. */
export function readQueryRegistry(source: string): RegistryQuery[] {
  const registry = /interface SanityQueries\s*\{/.exec(source);
  if (!registry) return [];
  const names = variableNames(source);
  const queries: RegistryQuery[] = [];
  let i = registry.index + registry[0].length;
  for (;;) {
    while (/\s/.test(source[i] ?? "")) i++;
    const c = source[i];
    if (c !== "'" && c !== '"') break;
    const { value, end } = readStringLiteral(source, i);
    const entry = /^\s*:\s*([\w.]+)\s*;/.exec(source.slice(end, end + 512));
    if (!entry) throw new SyntaxError(`expected ": Type;" after a registry key at ${end}`);
    const resultType = entry[1] as string;
    queries.push({ name: names.get(resultType) ?? resultType, resultType, query: value });
    i = end + entry[0].length;
  }
  return queries;
}
