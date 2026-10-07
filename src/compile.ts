import type { Program } from "./ast.js";
import type { CostModel } from "./cost.js";
import { utf8Length } from "./lexer.js";
import { minify } from "./minify.js";
import { checkTree, type Oracle } from "./oracle.js";
import { parse, ParseError } from "./parser.js";
import { print } from "./printer.js";
import {
  share as sharePass,
  type ShareOptions,
  type ShareRule,
  type SharedFunction,
  type SkipSummary,
} from "./share.js";
import { tidy } from "./tidy.js";

export interface CompileOptions {
  /** Drop trailing commas and use shorthand keys. Default true. */
  tidy?: boolean;
  /**
   * Share repeated projections as custom functions. `"documented"` (default) keeps function bodies free
   * of query parameters; `"with-params"` lets bodies read them (verified on the real API, undocumented).
   */
  share?: "off" | "documented" | "with-params";
  /** Let function bodies call other custom functions (verified on the real API, undocumented). Default false. */
  nested?: boolean;
  /** Minimise UTF-8 bytes (default) or the URL-encoded length `@sanity/client` sends with GET. */
  cost?: CostModel;
  /** Rename custom functions, existing ones included, and their parameters to short names. Default false. */
  mangle?: boolean;
  /**
   * `"tree"` proves the output with the oracle: original and compiled must parse to the same groq-js tree,
   * otherwise the result is the minified query with a fallback naming the rejected functions. Default
   * `"tree"` when an oracle is available (always through `groq-compiler/verify`), else `"off"`.
   */
  verify?: "tree" | "off";
  /** The oracle (groq-js `parse`); `groq-compiler/verify` passes it for you. */
  oracle?: Oracle;
  /** Testing only: switch off share-pass legality rules. */
  unsafeDisableRules?: readonly ShareRule[];
  /** Testing only: an extra transform applied after the share pass, to prove verification catches it. */
  unsafeTransform?: (program: Program) => void;
}

export type CompilePass = "as written" | "minify" | "print" | "tidy" | "share";

export interface CompileStep {
  pass: CompilePass;
  /** UTF-8 bytes after the pass. */
  bytes: number;
}

export interface Verification {
  mode: "tree" | "off";
  status: "passed" | "rejected" | "skipped";
  /** Milliseconds spent in the oracle, diagnosis included. */
  ms: number;
}

export interface CompileReport {
  steps: CompileStep[];
  verification: Verification;
  /** Candidate projections the share pass left inline, by reason. */
  skipped: Record<string, SkipSummary>;
  /** Declarations no call reached, removed by the share pass. */
  removedFunctions: string[];
  /** Existing functions renamed by `mangle`. */
  renamedFunctions: Record<string, string>;
}

export type FallbackStage = "parse" | "verify";

export interface Fallback {
  stage: FallbackStage;
  reason: string;
  /** Shared functions the oracle rejected on their own. */
  rejectedFunctions: string[];
}

export interface CompileResult {
  query: string;
  /** Custom functions the share pass declared. */
  functions: SharedFunction[];
  report: CompileReport;
  /** Present when compilation stopped early; `query` is then the minified query. */
  fallback?: Fallback;
}

/**
 * Compiles a GROQ query to a smaller equivalent query. Never throws on valid GROQ: input the compiler cannot
 * parse yields the minified query with a `fallback` reason.
 * @throws {TypeError} Non-string input or unpaired UTF-16 surrogates.
 * @throws {SyntaxError} Unterminated strings and invalid escapes (invalid GROQ).
 */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const minified = minify(source);
  const mode = options.verify ?? (options.oracle ? "tree" : "off");
  if (mode === "tree" && !options.oracle) {
    throw new TypeError(
      'verify: "tree" needs an oracle: import compile from "groq-compiler/verify" or pass options.oracle',
    );
  }
  const report: CompileReport = {
    steps: [
      { pass: "as written", bytes: utf8Length(source) },
      { pass: "minify", bytes: utf8Length(minified) },
    ],
    verification: { mode, status: "skipped", ms: 0 },
    skipped: {},
    removedFunctions: [],
    renamedFunctions: {},
  };
  const fallback = (stage: FallbackStage, reason: string, rejectedFunctions: string[] = []) => ({
    query: minified,
    functions: [],
    report,
    fallback: { stage, reason, rejectedFunctions },
  });
  let program: Program;
  try {
    program = parse(minified);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return fallback("parse", error.message);
  }
  let query = print(program);
  report.steps.push({ pass: "print", bytes: utf8Length(query) });
  if (options.tidy ?? true) {
    tidy(program);
    query = print(program);
    report.steps.push({ pass: "tidy", bytes: utf8Length(query) });
  }
  const tidied = query;
  let functions: SharedFunction[] = [];
  const share = options.share ?? "documented";
  const shareOptions: ShareOptions | undefined =
    share === "off"
      ? undefined
      : {
          mode: share,
          nested: options.nested ?? false,
          cost: options.cost ?? "bytes",
          mangle: options.mangle ?? false,
          ...(options.unsafeDisableRules ? { disabledRules: options.unsafeDisableRules } : {}),
        };
  if (shareOptions) {
    const result = sharePass(program, shareOptions);
    functions = result.functions;
    report.skipped = result.skipped;
    report.removedFunctions = result.removedFunctions;
    report.renamedFunctions = result.renamedFunctions;
    query = print(program);
    report.steps.push({ pass: "share", bytes: utf8Length(query) });
  }
  if (options.unsafeTransform) {
    options.unsafeTransform(program);
    query = print(program);
  }
  if (mode === "off" || !options.oracle) return { query, functions, report };

  const oracle = options.oracle;
  const started = performance.now();
  const finish = (status: Verification["status"]) => {
    report.verification = { mode, status, ms: performance.now() - started };
  };
  let reference: unknown;
  try {
    reference = oracle(minified);
  } catch (error) {
    finish("skipped");
    const message = error instanceof Error ? error.message : String(error);
    return fallback("verify", `the oracle cannot parse the minified query: ${message}`);
  }
  const check = checkTree(oracle, reference, query);
  if (check.status === "equal") {
    finish("passed");
    return { query, functions, report };
  }
  // Diagnose: was it tidy, or which shared functions does the oracle reject on their own?
  const rejected: string[] = [];
  let reason: string;
  if (checkTree(oracle, reference, tidied).status !== "equal") {
    reason = "the oracle rejected the tidy pass";
  } else {
    if (shareOptions) {
      for (const fn of functions) {
        const alone = parse(tidied);
        sharePass(alone, { ...shareOptions, only: new Set([fn.index]) });
        if (checkTree(oracle, reference, print(alone)).status !== "equal") rejected.push(fn.name);
      }
    }
    const detail = check.status === "invalid" ? ` (${check.error})` : "";
    reason =
      rejected.length > 0
        ? `the oracle rejected ${rejected.join(", ")}${detail}`
        : `the oracle rejected the output${detail}`;
  }
  finish("rejected");
  return fallback("verify", reason, rejected);
}
