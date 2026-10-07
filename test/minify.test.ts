import { evaluate, parse } from "groq-js";
import { describe, expect, it } from "vitest";

import { minify } from "../src/index.js";
import { cases } from "./support/fixtures.js";
import { generatedExpressions, generatedSoup } from "./support/random.js";

const dataset = [
  { _id: "first", _type: "entry", n: 3, name: "one" },
  { _id: "second", _type: "entry", n: 5, name: "two" },
];
const run = async (query: string) => (await evaluate(parse(query), { dataset })).get();
const bytes = (text: string) => Buffer.byteLength(text);

describe("valid fixtures", () => {
  for (const fixture of cases.valid) {
    it(fixture.name, async () => {
      const output = minify(fixture.input);
      expect(output).toBe(fixture.output);
      expect(minify(output)).toBe(output);
      expect(bytes(output)).toBeLessThanOrEqual(bytes(fixture.input));
      if (fixture.oracle) {
        expect(parse(output)).toEqual(parse(fixture.input));
        expect(await run(output)).toEqual(await run(fixture.input));
      } else {
        expect(fixture.reason, "every fixture outside the oracle needs a reason").toBeTruthy();
      }
    });
  }
});

describe("invalid fixtures", () => {
  for (const fixture of cases.invalid) {
    it(fixture.name, () => {
      expect(() => minify(fixture.input)).toThrow(SyntaxError);
      try {
        minify(fixture.input);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(fixture.reason);
        expect(message).toContain(`UTF-8 byte offset ${fixture.offset}`);
        expect(
          message.startsWith(fixture.kind === "unterminated" ? "unterminated" : "invalid"),
        ).toBe(true);
      }
    });
  }
});

it("handles every token pair across every whitespace and comment separator", () => {
  for (const [left, right, expected] of cases.pairs) {
    for (const separator of cases.separators) {
      expect(minify(left + separator + right), JSON.stringify(left + separator + right)).toBe(
        expected,
      );
    }
  }
});

it("preserves multiplication followed by everything", async () => {
  for (const separator of cases.separators) {
    const query = `2 *${separator}*[0].n`;
    const output = minify(query);
    expect(output).toBe("2* *[0].n");
    expect(parse(output)).toEqual(parse(query));
    expect(await run(output)).toBe(6);
  }
  expect(await run("2**[0].n")).not.toBe(6);
});

it("rejects unpaired UTF-16 before scanning, even in comments", () => {
  for (const query of ["\ud800", "\udc00", "// \ud800", '"\ud800"', "\ud800x", "\udc00\ud800"]) {
    expect(() => minify(query)).toThrow(TypeError);
  }
  expect(() => minify("ab\ud800")).toThrow("Unpaired UTF-16 surrogate at code unit offset 2");
  expect(minify('"👋"')).toBe('"👋"');
});

it("rejects non-string input with a TypeError", () => {
  for (const value of [null, undefined, 3, {}, new String("x")]) {
    expect(() => minify(value as string)).toThrow(new TypeError("GROQ query must be a string"));
  }
});

it("keeps every escape and literal spelling intact", () => {
  for (let count = 0; count < 32; count++) {
    const literal = '"' + "\\".repeat(count) + (count % 2 ? '"x' : "x") + '"';
    expect(minify(` ${literal} `)).toBe(literal);
  }
  expect(minify('"\\u{' + "0".repeat(100_000) + '41}"')).toHaveLength(100_008);
});

describe("properties", () => {
  it("generated expressions keep their tree and results", async () => {
    for (const query of generatedExpressions(256)) {
      const output = minify(query);
      expect(parse(output)).toEqual(parse(query));
      expect(await run(output)).toEqual(await run(query));
    }
  });

  it("output is idempotent and never grows", () => {
    const inputs = [
      ...cases.valid.map((fixture) => fixture.input),
      ...generatedExpressions(512, 7),
      ...generatedSoup(20_000, 11),
    ];
    let checked = 0;
    for (const input of inputs) {
      let output: string;
      try {
        output = minify(input);
      } catch (error) {
        expect(error).toBeInstanceOf(SyntaxError);
        continue;
      }
      checked++;
      expect(minify(output), JSON.stringify(input)).toBe(output);
      expect(bytes(output)).toBeLessThanOrEqual(bytes(input));
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});
