import { readFileSync } from "node:fs";
import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import { groqTree } from "../src/groq-tree.js";
import { tokenize } from "../src/lexer.js";
import { minify } from "../src/minify.js";
import { decodeString, parse, ParseError } from "../src/parser.js";
import { print } from "../src/printer.js";
import { describePrivate, privateQueries, pageBuilderQueries } from "./support/corpora.js";
import { cases, fixtureUrl } from "./support/fixtures.js";
import { generatedExpressions } from "./support/random.js";

const tokens = (text: string) => tokenize(text).map((t) => t.text);

/** print(parse(q)) reproduces the minified tokens, and both our tree and the printed text match groq-js. */
function roundTrip(query: string) {
  const program = parse(query);
  const printed = print(program);
  expect(printed).toBe(minify(query));
  const expected = groqParse(query);
  expect(groqParse(printed)).toEqual(expected);
  expect(groqTree(program)).toEqual(expected);
}

describe("round trip through the oracle", () => {
  describe("valid fixtures", () => {
    for (const fixture of cases.valid.filter((f) => f.oracle)) {
      it(fixture.name, () => roundTrip(fixture.input));
    }
  });

  it("keeps the tokens of every other parseable fixture", () => {
    for (const fixture of cases.valid.filter((f) => !f.oracle)) {
      let program;
      try {
        program = parse(fixture.input);
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError);
        continue;
      }
      expect(tokens(print(program))).toEqual(tokens(fixture.input));
    }
  });

  describe("page-builder queries", () => {
    for (const { name, query } of pageBuilderQueries) it(name, () => roundTrip(query));
  });

  describe.skipIf(privateQueries.length === 0)(describePrivate, () => {
    it("every query", () => {
      for (const { query } of privateQueries) roundTrip(query);
    });
  });

  it("generated expressions", () => {
    for (const query of generatedExpressions(512, 99)) roundTrip(query);
  });

  it("precedence, associativity and traversal grouping", () => {
    for (const query of [
      "1 + 2 * 3 - 4 / 5 % 6",
      "2 ** 3 ** 2",
      "-2 ** 2",
      "+a.b",
      "!a == b",
      "a || b && c || d",
      "a == b && c != d || e < f && g <= h || i > j && k >= l",
      'a in [1, 2] && b match "x*"',
      "x in 1..3",
      "x in (1...3)",
      "x in (y)",
      '*[_type == "a"] | order(a desc, b asc)[0...10]{a, "b": c->d}',
      "*{a}|{b}",
      "@ | {a}",
      "a[].b[0]",
      "(a[].b)[0]",
      "(a[]).b",
      "a[0]{b}.c",
      "a[b > 1][0..2]",
      'a["key"]',
      "a[1 + 1]",
      "a[-1]",
      "a[$i]",
      "a->",
      "a->b",
      "a[]->{b}",
      "^.^._id",
      "*[references(^._id)]",
      '{"k": v, ...x, ..., c => {d}, e{f}}',
      "[1, ...a, [], {}]",
      "select(a => 1, b => 2, 3)",
      "coalesce(a, b,)",
      "pt::text(body)",
      "count(*[_type == $type])",
      'fn ns::f($x) = $x{a}; fn ns::g($x) = $x[]->{"f": ns::f(@)}; ns::g(items)',
      "true && false || null == x",
      "a asc",
    ]) {
      if (query === "a asc") {
        expect(print(parse(query))).toBe("a asc");
        continue;
      }
      roundTrip(query);
    }
  });
});

describe("parse errors", () => {
  it("throws typed errors with UTF-16 and UTF-8 positions", () => {
    for (const [query, position] of [
      ["*[", 2],
      ["a b", 2],
      ["{", 1],
      ["a é", 2],
      ["é", 0],
      ["1e5e", 3],
      ["(1, 2,)", 6],
      ["$ x", 2],
      ["1..3", 1],
      ["", 0],
    ] as const) {
      expect(() => parse(query), query).toThrow(ParseError);
      try {
        parse(query);
      } catch (error) {
        const e = error as ParseError;
        expect(e.position, query).toBe(position);
        expect(e.byteOffset).toBe(Buffer.byteLength(query.slice(0, position)));
        expect(e.kind).toBe("syntax");
      }
    }
  });

  it("marks valid but unmodelled syntax as unsupported", () => {
    expect(() => parse("diff::changedAny(a.(b, c))")).toThrow(ParseError);
    try {
      parse("diff::changedAny(a.(b, c))");
    } catch (error) {
      expect((error as ParseError).kind).toBe("unsupported");
    }
  });

  it("keeps the lexer's errors", () => {
    expect(() => parse('"abc')).toThrow(SyntaxError);
    expect(() => parse('"abc')).not.toThrow(ParseError);
    expect(() => parse(1 as unknown as string)).toThrow(TypeError);
  });
});

describe("literals", () => {
  it("keeps spelling and decodes values", () => {
    const program = parse(`{'k\\u00e9': "a\\nb\\u{1F600}\\uD83D\\uDE00", "n": 1.50e+2}`);
    expect(print(program)).toBe(`{'k\\u00e9':"a\\nb\\u{1F600}\\uD83D\\uDE00","n":1.50e+2}`);
    expect(decodeString(`"a\\nb\\u{1F600}\\uD83D\\uDE00"`)).toBe("a\nb😀😀");
  });
});

interface Divergence {
  name: string;
  input: string;
  compiler: "parses" | "SyntaxError" | "ParseError";
  printed?: string;
  value?: string;
  groqJs: "accepts" | "rejects";
  groqJsValue?: string;
  reason: string;
}

describe("groq-js divergences", () => {
  const divergences: Divergence[] = JSON.parse(
    readFileSync(fixtureUrl("groq-js-divergences.json"), "utf8"),
  );
  for (const d of divergences) {
    it(d.name, () => {
      expect(d.reason).toBeTruthy();
      if (d.groqJs === "rejects") expect(() => groqParse(d.input)).toThrow();
      else expect(() => groqParse(d.input)).not.toThrow();
      if (d.compiler === "parses") {
        const program = parse(d.input);
        expect(print(program)).toBe(d.printed);
        expect(() => groqParse(d.printed as string)).not.toThrow();
        if (d.value !== undefined) {
          expect(program.body).toMatchObject({ type: "String", value: d.value });
          expect(groqParse(d.input)).toEqual({ type: "Value", value: d.groqJsValue });
        }
      } else {
        const type = d.compiler === "SyntaxError" ? SyntaxError : ParseError;
        expect(() => parse(d.input)).toThrow(type);
      }
    });
  }
});
