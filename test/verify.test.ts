import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import type { Node } from "../src/ast.js";
import { compile as compileCore, minify } from "../src/index.js";
import { compile, oracle, sameResults, sameTree } from "../src/verify.js";
import { walk } from "../src/walk.js";
import { pageBuilderDataset, pageBuilderQuery } from "./support/corpora.js";
import { seedParamSets } from "./support/seed.js";

const BODY = '"label": a, "b": b->{_id, title}, "c": c[]{_key, value}, "d": coalesce(d, "none")';
const MAPPED = `{"x": *[_type == "a"]{${BODY}}, "y": items[kind == "b"]{${BODY}}, "p": p{${BODY}}, "q": q{${BODY}}}`;

describe("verify entry", () => {
  it("compares trees and dataset results", async () => {
    expect(sameTree("*[_type == 'a']{b}", '*[_type=="a"]{b}')).toBe(true);
    expect(sameTree("(a[].b)[0]", "a[].b[0]")).toBe(false);
    const query = pageBuilderQuery("pageQuery");
    const compiled = compile(query, { share: "with-params", nested: true }).query;
    const checks = await sameResults(query, compiled, {
      dataset: pageBuilderDataset,
      paramSets: seedParamSets["pageQuery"] ?? [],
    });
    expect(checks).toHaveLength(11);
    expect(checks.every((c) => c.same)).toBe(true);
  });

  it("verifies by default", () => {
    const result = compile(pageBuilderQuery("pageQuery"));
    expect(result.report.verification.status).toBe("passed");
    expect(result.fallback).toBeUndefined();
    expect(compileCore("*{a}").report.verification.mode).toBe("off");
    expect(compile("*{a}", { verify: "off" }).report.verification.mode).toBe("off");
  });

  it("requires an oracle for tree verification", () => {
    expect(() => compileCore("*", { verify: "tree" })).toThrow(TypeError);
  });

  it("falls back when the oracle cannot parse the input", () => {
    const result = compile("* | foo");
    expect(result.fallback?.stage).toBe("parse");
    const odd = compile("count(*) // trailing comment");
    expect(odd.fallback).toBeUndefined(); // the minified query has no comment left
  });
});

describe("broken transforms fall back", () => {
  it("names the shared function the oracle rejects", () => {
    // Switching off the traversal rule shares a projection that maps over an array: a broken transform.
    const result = compile(MAPPED, { unsafeDisableRules: ["traversal"] });
    expect(result.query).toBe(minify(MAPPED));
    expect(result.fallback?.stage).toBe("verify");
    expect(result.fallback?.rejectedFunctions).toHaveLength(1);
    expect(result.fallback?.reason).toContain(result.fallback?.rejectedFunctions[0]);
    expect(result.report.verification.status).toBe("rejected");
    // The same query compiles correctly with the rule, sharing only the plain projections.
    const correct = compile(MAPPED);
    expect(correct.fallback).toBeUndefined();
    expect(correct.functions).toHaveLength(1);
    expect(groqParse(correct.query)).toEqual(groqParse(MAPPED));
  });

  it("catches a transform outside the share pass", () => {
    const corrupt = (program: { body: Node }) =>
      walk(program.body, (node) => {
        if (node.type === "String" && node.value === "none") {
          node.raw = '"nil"';
          node.value = "nil";
        }
      });
    const result = compile(MAPPED, { unsafeTransform: corrupt });
    expect(result.query).toBe(minify(MAPPED));
    expect(result.fallback).toMatchObject({ stage: "verify", rejectedFunctions: [] });
    expect(result.fallback?.reason).toBe("the oracle rejected the output");
  });

  it("reports invalid output", () => {
    const result = compile(MAPPED, {
      unsafeTransform: (program) => {
        program.functions.push({ ...program.functions[0]!, name: "dup", params: ["x", "y"] });
      },
    });
    expect(result.fallback?.stage).toBe("verify");
    expect(result.fallback?.reason).toMatch(/the oracle rejected the output \(.+\)/);
  });
});

describe("cost of verification", () => {
  const time = (run: () => unknown, rounds: number) => {
    for (let i = 0; i < 10; i++) run();
    const start = performance.now();
    for (let i = 0; i < rounds; i++) run();
    return (performance.now() - start) / rounds;
  };

  it("stays within 3x of unverified compilation for page-builder pageQuery", () => {
    const query = pageBuilderQuery("pageQuery");
    const ratios: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const unverified = time(() => compileCore(query), 40);
      const verified = time(() => compileCore(query, { oracle }), 40);
      ratios.push(verified / unverified);
    }
    const ratio = Math.min(...ratios);
    process.stdout.write(`Verification ratio for pageQuery: ${ratio.toFixed(2)}x\n`);
    expect(ratio).toBeLessThan(3);
  });
});
