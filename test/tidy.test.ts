import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  describePrivate,
  privateQueries,
  pageBuilderQueries,
  pageBuilderQuery,
} from "./support/corpora.js";
import { cases } from "./support/fixtures.js";

const tidied = (query: string) => compile(query).query;

function oracle(query: string) {
  const result = compile(query);
  expect(result.fallback).toBeUndefined();
  expect(groqParse(result.query)).toEqual(groqParse(query));
  return result;
}

describe("tidy", () => {
  it("drops trailing commas in objects, arrays and calls", () => {
    expect(tidied("{a, b,}")).toBe("{a,b}");
    expect(tidied("[1, 2,]")).toBe("[1,2]");
    expect(tidied("coalesce(a, b,)")).toBe("coalesce(a,b)");
    expect(tidied("*{a{b,},}")).toBe("*{a{b}}");
  });

  it("writes shorthand members", () => {
    expect(tidied('{"x": x, "y": y->, "_type": _type}')).toBe("{x,y->,_type}");
    expect(tidied("{'x': x}")).toBe("{x}");
    expect(tidied('{"\\u0078": x}')).toBe("{x}");
  });

  it("leaves members whose shorthand would mean something else", () => {
    for (const query of [
      '{"x": y}',
      '{"x": x.y}',
      '{"x": x->y}',
      '{"x": x[]}',
      '{"x": x{a}}',
      '{"null": null}',
      '{"true": true}',
      '{"x y": x}',
      '{"1": x}',
      '{"x": ^.x}',
      '{"x": $x}',
    ]) {
      expect(tidied(query)).toBe(compile(query, { tidy: false }).query);
    }
  });

  it("leaves existing function declarations untouched", () => {
    expect(tidied('fn a::b($p) = $p{"x": x,}; a::b(@){"y": y,}')).toBe(
      'fn a::b($p)=$p{"x":x,};a::b(@){y}',
    );
  });

  it("can be turned off", () => {
    expect(compile("{a,}", { tidy: false }).query).toBe("{a,}");
  });
});

describe("oracle", () => {
  it("valid fixtures", () => {
    for (const fixture of cases.valid.filter((f) => f.oracle)) oracle(fixture.input);
  });

  it("page-builder queries", () => {
    for (const { query } of pageBuilderQueries) oracle(query);
  });

  describe.skipIf(privateQueries.length === 0)(describePrivate, () => {
    it("every query", () => {
      for (const { query } of privateQueries) oracle(query);
    });
  });
});

it("reaches the page-builder pageQuery tidy baseline (12,663 bytes)", () => {
  const result = oracle(pageBuilderQuery("pageQuery"));
  const bytes = Object.fromEntries(result.report.steps.map((s) => [s.pass, s.bytes]));
  expect(bytes["as written"]).toBe(18_809);
  expect(bytes["minify"]).toBe(12_755);
  expect(bytes["tidy"]).toBeLessThanOrEqual(12_663);
});
