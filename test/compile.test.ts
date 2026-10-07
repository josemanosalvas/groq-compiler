import { describe, expect, it } from "vitest";

import { compile, minify, ParseError } from "../src/index.js";
import { pageBuilderQueries } from "./support/corpora.js";

describe("fallback", () => {
  it("returns the minified query with a reason when parsing fails", () => {
    for (const query of ["* | foo", "x in (1, 2)", "diff::changedAny(a.(b, c))", "1..3"]) {
      const result = compile(` ${query} `);
      expect(result.query).toBe(minify(query));
      expect(result.fallback?.stage).toBe("parse");
      expect(result.fallback?.reason).toMatch(/UTF-8 byte offset \d+/);
    }
  });

  it("never throws on valid GROQ", () => {
    for (const { query } of pageBuilderQueries) {
      expect(() => compile(query)).not.toThrow();
      expect(compile(query).fallback).toBeUndefined();
    }
  });

  it("throws the minifier's errors for invalid strings and non-strings", () => {
    expect(() => compile('"\\q"')).toThrow(SyntaxError);
    expect(() => compile('"\\q"')).not.toThrow(ParseError);
    expect(() => compile(null as unknown as string)).toThrow(TypeError);
  });
});
