// groq-compiler/verify: the oracle (groq-js 2.0.0, an optional peer dependency) and checks built on it.
import { evaluate, parse } from "groq-js";

import { compile as compileCore, type CompileOptions, type CompileResult } from "./compile.js";
import { deepEqual, type Oracle } from "./oracle.js";

export { checkSanityRules, type SanityRuleOptions } from "./sanity-rules.js";
export { deepEqual, type Oracle } from "./oracle.js";

/** groq-js `parse`: custom functions are expanded, so equal trees mean equal results for every dataset. */
export const oracle: Oracle = (query) => parse(query);

/** Whether two queries parse to the same groq-js tree. Throws when either does not parse. */
export function sameTree(original: string, compiled: string): boolean {
  return deepEqual(parse(original), parse(compiled));
}

export interface ResultCheck {
  params: Record<string, unknown>;
  same: boolean;
  original: unknown;
  compiled: unknown;
}

export interface ResultCheckOptions {
  /** Documents to query (groq-js evaluates `*` over them). */
  dataset: unknown[];
  /** One evaluation per parameter set. Default: a single run without parameters. */
  paramSets?: Record<string, unknown>[];
}

/** Evaluates both queries with groq-js for every parameter set and compares the results. */
export async function sameResults(
  original: string,
  compiled: string,
  { dataset, paramSets = [{}] }: ResultCheckOptions,
): Promise<ResultCheck[]> {
  const originalTree = parse(original);
  const compiledTree = parse(compiled);
  const checks: ResultCheck[] = [];
  for (const params of paramSets) {
    const before = await (await evaluate(originalTree, { dataset, params })).get();
    const after = await (await evaluate(compiledTree, { dataset, params })).get();
    checks.push({ params, same: deepEqual(before, after), original: before, compiled: after });
  }
  return checks;
}

/** `compile` with the oracle, so `verify: "tree"` is the default. */
export function compile(query: string, options: CompileOptions = {}): CompileResult {
  return compileCore(query, { oracle, ...options });
}
