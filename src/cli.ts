#!/usr/bin/env node
// groq-compiler command line: compile, budget, split, dedupe-types and typegen.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { budget, GET_QUERY_LIMIT, type QueryParams } from "./budget.js";
import { compile, type CompileOptions } from "./compile.js";
import type { Oracle } from "./oracle.js";
import { parse } from "./parser.js";
import { readQueryRegistry } from "./typegen.js";
import { walk } from "./walk.js";

const USAGE = `Usage: groq-compiler <command> [options]

Commands:
  compile [file]                 Compile a query (file or stdin) and print it
  budget <sanity.types.ts>       Report every TypeGen query as GET or POST with its margin
  split <file> [--query NAME]    Split a page query per block type and report each query's GET budget
                                 (file: a sanity.types.ts registry or a query)
  dedupe-types <sanity.types.ts> Name repeated object types in TypeGen output (needs typescript 5.9/6)
  typegen <sanity.types.ts>      Write a module mapping each TypeGen query to its compiled text (--out)

Compile options (compile, budget):
  --share off|documented|with-params   Share repeated projections (default documented)
  --nested                             Let functions call functions
  --cost bytes|url                     What sharing minimises (default bytes)
  --mangle                             Rename custom functions and parameters
  --no-tidy                            Keep trailing commas and long keys
  --no-verify                          Skip the groq-js oracle

Other options:
  --params <json>        Query parameters for budget (only those a query uses are sent)
  --report               compile: print the report as JSON to stderr
  --json                 budget: print JSON instead of a table
  --out <file>           dedupe-types: write here instead of stdout; split: write the plan as JSON
  --check                typegen: fail if --out is not up to date instead of writing it
  --query <name>         split: the registry query to split (default: the largest)
  --blocks <key>         split: the page member holding the blocks (default: detected)
  --containers <list>    split: auto (default), none, or comma-separated container block types
  --typescript <dir>     dedupe-types: the typescript 5.9/6 package to use (default: the installed one)
  -h, --help             Show this help
`;

const COMPILE_FLAGS = {
  share: { type: "string" },
  nested: { type: "boolean" },
  cost: { type: "string" },
  mangle: { type: "boolean" },
  "no-tidy": { type: "boolean" },
  "no-verify": { type: "boolean" },
} as const satisfies ParseArgsConfig["options"];

type Values = Record<string, string | boolean | undefined>;

export class UsageError extends Error {
  override name = "UsageError";
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Loads groq-js when it is installed; compile then verifies every query. */
async function loadOracle(): Promise<Oracle | undefined> {
  try {
    const { parse: groqParse } = await import("groq-js");
    return (query) => groqParse(query);
  } catch {
    return undefined;
  }
}

async function compileOptions(values: Values): Promise<CompileOptions> {
  const share = choice(values["share"], ["off", "documented", "with-params"], "share");
  const cost = choice(values["cost"], ["bytes", "url"], "cost");
  const options: CompileOptions = {
    tidy: !values["no-tidy"],
    nested: Boolean(values["nested"]),
    mangle: Boolean(values["mangle"]),
    ...(share ? { share } : {}),
    ...(cost ? { cost } : {}),
  };
  if (values["no-verify"]) return { ...options, verify: "off" };
  const oracle = await loadOracle();
  if (!oracle) {
    process.stderr.write("groq-js is not installed: compiling without the oracle.\n");
    return { ...options, verify: "off" };
  }
  return { ...options, oracle };
}

function readInput(file: string | undefined): string {
  return readFileSync(file === undefined || file === "-" ? 0 : file, "utf8");
}

function parameterNames(query: string): Set<string> {
  const names = new Set<string>();
  try {
    const program = parse(query);
    const visit = (node: Parameters<Parameters<typeof walk>[1]>[0]) => {
      if (node.type === "Parameter") names.add(node.name);
    };
    walk(program.body, visit);
    for (const fn of program.functions) walk(fn.body, visit);
    for (const fn of program.functions) for (const p of fn.params) names.delete(p);
  } catch {
    // Unparseable queries are reported with every parameter.
  }
  return names;
}

async function runCompile(positionals: string[], values: Values): Promise<void> {
  const options = await compileOptions(values);
  const result = compile(readInput(positionals[0]), options);
  process.stdout.write(`${result.query}\n`);
  if (result.fallback) {
    process.stderr.write(`Fallback (${result.fallback.stage}): ${result.fallback.reason}\n`);
  }
  if (values["report"]) {
    process.stderr.write(
      `${JSON.stringify({ functions: result.functions, ...result.report }, null, 2)}\n`,
    );
  }
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString("en").padStart(9);

async function runBudget(positionals: string[], values: Values): Promise<void> {
  const file = positionals[0];
  if (!file) throw new UsageError("budget needs a sanity.types.ts file");
  const queries = readQueryRegistry(readFileSync(file, "utf8"));
  if (queries.length === 0) throw new UsageError(`${file} has no TypeGen query registry`);
  const allParams: QueryParams = values["params"] ? JSON.parse(String(values["params"])) : {};
  const options = await compileOptions(values);
  const rows = queries.map(({ name, query }) => {
    const used = parameterNames(query);
    const params = Object.fromEntries(Object.entries(allParams).filter(([key]) => used.has(key)));
    const result = compile(query, options);
    const [minified, compiled] = budget([
      { name, query: compile(query, { share: "off", tidy: false, verify: "off" }).query, params },
      { name, query: result.query, params },
    ]);
    return { name, minified, compiled, fallback: result.fallback?.reason };
  });
  if (values["json"]) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const width = Math.max(5, ...rows.map((r) => r.name.length));
  const lines = [
    `${"Query".padEnd(width)}  minified (encoded)   compiled (encoded)    margin`,
    ...rows
      .toSorted((a, b) => (b.compiled?.encoded ?? 0) - (a.compiled?.encoded ?? 0))
      .map(
        (r) =>
          `${r.name.padEnd(width)}  ${num(r.minified?.encoded)} ${(r.minified?.method ?? "").padEnd(6)}` +
          `     ${num(r.compiled?.encoded)} ${(r.compiled?.method ?? "").padEnd(6)} ${num(r.compiled?.margin)}` +
          (r.fallback ? `  (fallback: ${r.fallback})` : ""),
      ),
  ];
  const over = rows.filter((r) => r.compiled?.method === "POST").map((r) => r.name);
  lines.push(
    "",
    `GET budget: encoded query string shorter than ${GET_QUERY_LIMIT.toLocaleString("en")} characters.`,
    over.length === 0
      ? `All ${rows.length} compiled queries are sent as GET.`
      : `${rows.length - over.length}/${rows.length} compiled queries are sent as GET; POST: ${over.join(", ")}.`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runSplit(positionals: string[], values: Values): Promise<void> {
  const file = positionals[0];
  if (!file) throw new UsageError("split needs a sanity.types.ts file or a query file");
  const text = readFileSync(file, "utf8");
  const registry = readQueryRegistry(text);
  let query = text;
  let name = file;
  if (registry.length > 0) {
    const wanted = values["query"] as string | undefined;
    const entry = wanted
      ? registry.find((q) => q.name === wanted)
      : registry.toSorted((a, b) => b.query.length - a.query.length)[0];
    if (!entry) throw new UsageError(`${file} has no query named ${wanted}`);
    query = entry.query;
    name = entry.name;
  }
  const containersFlag = values["containers"] as string | undefined;
  const containers =
    containersFlag === undefined || containersFlag === "auto" || containersFlag === "none"
      ? (containersFlag ?? "auto")
      : containersFlag.split(",").map((t) => t.trim());
  const params: QueryParams = values["params"] ? JSON.parse(String(values["params"])) : {};
  const { split, splitBudget, toPlan } = await import("./split.js");
  const { formatBudget } = await import("./budget.js");
  const result = split(query, {
    compile: await compileOptions(values),
    containers,
    params,
    ...(values["blocks"] ? { blocks: String(values["blocks"]) } : {}),
  });
  if (values["out"])
    writeOutput(String(values["out"]), `${JSON.stringify(toPlan(result), null, 2)}\n`);
  if (values["json"]) {
    process.stdout.write(`${JSON.stringify(splitBudget(result, params), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${name}: outline and ${result.details.length} block queries\n\n`);
  process.stdout.write(`${formatBudget(splitBudget(result, params))}\n`);
}

async function runTypegen(positionals: string[], values: Values): Promise<number> {
  const file = positionals[0];
  const out = values["out"] as string | undefined;
  if (!file) throw new UsageError("typegen needs a sanity.types.ts file");
  if (!out) throw new UsageError("typegen needs --out <compiled-queries.ts>");
  const { compileRegistry, compiledQueriesModule, registrySummary } = await import("./sanity.js");
  const entries = compileRegistry(readFileSync(file, "utf8"), await compileOptions(values));
  if (entries.length === 0) throw new UsageError(`${file} has no TypeGen query registry`);
  const flags = [
    values["share"] ? `--share ${String(values["share"])}` : "",
    values["nested"] ? "--nested" : "",
    values["cost"] ? `--cost ${String(values["cost"])}` : "",
    values["mangle"] ? "--mangle" : "",
    values["no-tidy"] ? "--no-tidy" : "",
  ].filter(Boolean);
  const text = compiledQueriesModule(entries, {
    command: ["groq-compiler typegen", ...flags].join(" "),
  });
  if (values["check"]) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {
      // A missing file is stale.
    }
    if (current !== text) {
      process.stderr.write(
        `${out} is out of date: run groq-compiler typegen ${file} --out ${out}\n`,
      );
      return 1;
    }
    process.stderr.write(`${out} is up to date.\n`);
    return 0;
  }
  writeFileSync(out, text);
  process.stderr.write(`${registrySummary(entries)}\nWrote ${out}\n`);
  return 0;
}

async function runDedupeTypes(positionals: string[], values: Values): Promise<void> {
  const file = positionals[0];
  if (!file) throw new UsageError("dedupe-types needs a sanity.types.ts file");
  const { dedupeTypes } = await import("./types.js");
  let ts: unknown;
  if (values["typescript"]) {
    const require = createRequire(import.meta.url);
    ts = require(resolve(String(values["typescript"])));
  }
  const result = await dedupeTypes(readFileSync(file, "utf8"), ts ? { ts: ts as never } : {});
  writeOutput(values["out"] as string | undefined, result.output);
  const { inputBytes, outputBytes } = result.stats;
  process.stderr.write(
    `${file}: ${inputBytes.toLocaleString("en")} → ${outputBytes.toLocaleString("en")} bytes, ` +
      `${result.aliases.length} aliases, ${result.reused.length} declarations reused\n`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const commands: Record<
    string,
    (positionals: string[], values: Values) => Promise<number | void>
  > = {
    compile: runCompile,
    budget: runBudget,
    split: runSplit,
    "dedupe-types": runDedupeTypes,
    typegen: runTypegen,
  };
  const run = commands[command];
  if (!run) throw new UsageError(`unknown command "${command}"`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...COMPILE_FLAGS,
      params: { type: "string" },
      report: { type: "boolean" },
      json: { type: "boolean" },
      check: { type: "boolean" },
      out: { type: "string" },
      typescript: { type: "string" },
      query: { type: "string" },
      blocks: { type: "string" },
      containers: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return (await run(positionals, values)) ?? 0;
}

export function writeOutput(path: string | undefined, text: string): void {
  if (path === undefined || path === "-") process.stdout.write(text);
  else writeFileSync(path, text);
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`groq-compiler: ${message}\n`);
      if (error instanceof UsageError) process.stderr.write(`\n${USAGE}`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
