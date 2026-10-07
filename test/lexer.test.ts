import { describe, expect, it } from "vitest";

import { joinTokens, tokenize, utf8Length } from "../src/lexer.js";
import { minify } from "../src/minify.js";
import { cases } from "./support/fixtures.js";
import { generatedExpressions, generatedSoup } from "./support/random.js";

describe("tokenize", () => {
  it("reports kinds and UTF-16 and UTF-8 spans", () => {
    const query = '{"é👋": a.b} // comment\n-> 1.5e+3';
    const tokens = tokenize(query);
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ["punctuator", "{"],
      ["string", '"é👋"'],
      ["punctuator", ":"],
      ["identifier", "a"],
      ["punctuator", "."],
      ["identifier", "b"],
      ["punctuator", "}"],
      ["punctuator", "->"],
      ["number", "1.5e+3"],
    ]);
    for (const token of tokens) {
      expect(query.slice(token.start, token.end)).toBe(token.text);
      expect(token.byteStart).toBe(Buffer.byteLength(query.slice(0, token.start)));
      expect(token.byteEnd - token.byteStart).toBe(Buffer.byteLength(token.text));
    }
    expect(tokens.map((t) => t.spaceBefore)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("throws the minifier's errors", () => {
    expect(() => tokenize('"\\q"')).toThrow(
      "invalid escape (unknown escape sequence) at UTF-8 byte offset 1",
    );
    expect(() => tokenize(3 as unknown as string)).toThrow(TypeError);
  });

  it("measures UTF-8 like Buffer.byteLength", () => {
    for (const text of ["", "abc", "é", "你好", "👋", "a👋é\u0085", ...generatedSoup(200, 3)]) {
      expect(utf8Length(text)).toBe(Buffer.byteLength(text));
    }
  });
});

const retokenizes = (input: string) => {
  const texts = tokenize(input).map((t) => t.text);
  const joined = joinTokens(texts);
  expect(
    tokenize(joined).map((t) => t.text),
    JSON.stringify(input),
  ).toEqual(texts);
  return joined;
};

describe("joinTokens", () => {
  // The printer joins tokens with the minifier's separator rules. On any input it keeps the token sequence;
  // on valid GROQ it also matches the minifier. (On invalid input the two may differ: "1 .2" versus "1. 2",
  // or "0b", which the minifier keeps adjacent because the original was.)
  it("matches minify on valid GROQ", () => {
    const valid = [
      ...cases.valid.filter((fixture) => fixture.oracle).map((fixture) => fixture.input),
      ...generatedExpressions(256, 5),
    ];
    for (const input of valid) expect(retokenizes(input)).toBe(minify(input));
  });

  it("keeps the token sequence of any input", () => {
    const inputs = [
      ...cases.valid.map((fixture) => fixture.input),
      ...cases.pairs.map(([left, right]) => `${left} ${right}`),
      ...generatedSoup(20_000, 17),
    ];
    for (const input of inputs) {
      try {
        tokenize(input);
      } catch {
        continue;
      }
      retokenizes(input);
    }
  });
});
