import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  compiledQueriesModule,
  compiledQuery,
  compileRegistry,
  readQueryRegistry,
  registrySummary,
  withCompiledQueries,
} from "../src/sanity.js";
import { oracle } from "../src/verify.js";
import { pageBuilderQueries } from "./support/corpora.js";
import { runSeed, seedParamSets } from "./support/seed.js";

/** A TypeGen-shaped file holding the page-builder query registry. */
const typegenSource = [
  "// Query TypeMap",
  "declare global {",
  "  interface SanityQueries {",
  ...pageBuilderQueries.map((q) => `    ${JSON.stringify(q.query)}: ${q.resultType};`),
  "  }",
  "}",
  "",
].join("\n");

async function load(module: string): Promise<ReadonlyMap<string, string>> {
  const js = ts.transpileModule(module, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const loaded = (await import(`data:text/javascript,${encodeURIComponent(js)}`)) as {
    compiledQueries: ReadonlyMap<string, string>;
  };
  return loaded.compiledQueries;
}

describe("registry compiler", () => {
  const entries = compileRegistry(typegenSource, { share: "with-params", nested: true, oracle });

  it("compiles every registry query, verified", () => {
    expect(readQueryRegistry(typegenSource).map((q) => q.query)).toEqual(
      pageBuilderQueries.map((q) => q.query),
    );
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.result.fallback).toBeUndefined();
      expect(entry.result.report.verification.status).toBe("passed");
    }
    expect(registrySummary(entries)).toMatch(/PageQueryResult\s+18,809 →\s+4,340 bytes {2}GET/);
  });

  it("generates a deterministic module that maps originals to compiled queries", async () => {
    const module = compiledQueriesModule(entries, {
      command: "groq-compiler typegen --share with-params --nested",
    });
    expect(
      compiledQueriesModule(entries, {
        command: "groq-compiler typegen --share with-params --nested",
      }),
    ).toBe(module);
    const compiled = await load(module);
    expect(compiled.size).toBe(entries.filter((e) => e.compiled !== e.query).length);
    for (const entry of entries) expect(compiledQuery(compiled, entry.query)).toBe(entry.compiled);
    expect(compiledQuery(compiled, "*[0]")).toBe("*[0]");
  });

  it("sends compiled queries through a wrapped fetch with identical seed results", async () => {
    const compiled = await load(compiledQueriesModule(entries));
    const sent: string[] = [];
    const fetch = async (options: { query: string; params: Record<string, unknown> }) => {
      sent.push(options.query);
      return runSeed(options.query, options.params);
    };
    const wrapped = withCompiledQueries(fetch, compiled);
    for (const { name, query } of pageBuilderQueries) {
      for (const params of seedParamSets[name] ?? [{}]) {
        expect(await wrapped({ query, params })).toEqual(await runSeed(query, params));
      }
    }
    expect(sent.some((q) => q.startsWith("fn "))).toBe(true);
  });
});
