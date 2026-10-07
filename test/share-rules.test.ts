// Each legality rule from findings, "GROQ traps", has a fixture that compiles correctly with the rule and
// fails without it: the oracle rejects the output, Sanity's function rules reject it, or an existing
// declaration changes.
import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import { compile, type CompileOptions } from "../src/index.js";
import { parse } from "../src/parser.js";
import { print } from "../src/printer.js";
import { checkSanityRules } from "../src/sanity-rules.js";
import type { ShareRule } from "../src/share.js";

const BODY = '"label": a, "b": b->{_id, title}, "c": c[]{_key, value}, "d": coalesce(d, "none")';

type Failure = "oracle" | "sanity" | "existing declaration";

interface RuleFixture {
  rule: ShareRule;
  trap: string;
  query: string;
  options?: CompileOptions;
  fails: Failure;
}

const FIXTURES: RuleFixture[] = [
  {
    rule: "traversal",
    trap: "1. projection over a traversal maps over the array",
    query: `{"x": *[_type == "a"]{${BODY}}, "y": items[kind == "b"]{${BODY}}}`,
    fails: "oracle",
  },
  {
    rule: "pipe",
    trap: "2. a projection after a pipe applies to the whole pipe expression",
    query: `{"x": *[_type == "a"] | order(n){${BODY}}, "y": *[_type == "b"] | order(m){${BODY}}}`,
    fails: "oracle",
  },
  {
    rule: "parentheses",
    trap: "3. parentheses end traversals and must stay in the call argument",
    query: `{"x": (a[].b){${BODY}}, "y": (c[].d){${BODY}}}`,
    fails: "oracle",
  },
  {
    rule: "parent-scope",
    trap: "4. Sanity rejects a body using the parent scope",
    query: `*[_type == "page"][0]{"x": x{${BODY}, "page": ^._id}, "y": y{${BODY}, "page": ^._id}}`,
    fails: "sanity",
  },
  {
    rule: "result-used-further",
    trap: "5. a projection followed by [0] maps; a call followed by [0] does not",
    query: `{"x": x{${BODY}}[0], "y": y{${BODY}}[0]}`,
    fails: "oracle",
  },
  {
    rule: "shorthand-key",
    trap: "6. a shorthand member needs an explicit key once it is a call",
    query: `*[0]{image{${BODY}}, poster{${BODY}}}`,
    fails: "sanity",
  },
  {
    rule: "parameter-name",
    trap: "7. the function parameter must not collide with a query parameter",
    query: `*[0]{"x": x{${BODY}, "v": $a}, "y": y{${BODY}, "v": $a}}`,
    options: { share: "with-params" },
    fails: "oracle",
  },
  {
    rule: "declaration-order",
    trap: "8. callees are declared before callers",
    query: `*[0]{"x": x{"i": i{${BODY}}, "j": j{${BODY}}, "k": 1}, "y": y{"i": i{${BODY}}, "j": j{${BODY}}, "k": 1}}`,
    options: { share: "with-params", nested: true },
    fails: "sanity",
  },
  {
    rule: "existing-functions",
    trap: "9. existing declarations stay untouched",
    query: `fn link::card($l) = $l{"media": media{${BODY}}}; *[0]{"x": link::card(x), "y": y{${BODY}}}`,
    options: { share: "documented", nested: true },
    fails: "existing declaration",
  },
];

function failures(fixture: RuleFixture, disabled: boolean): Failure[] {
  const options: CompileOptions = {
    share: "documented",
    ...fixture.options,
    ...(disabled ? { unsafeDisableRules: [fixture.rule] } : {}),
  };
  const result = compile(fixture.query, options);
  expect(result.fallback).toBeUndefined();
  const found: Failure[] = [];
  try {
    if (JSON.stringify(groqParse(result.query)) !== JSON.stringify(groqParse(fixture.query))) {
      found.push("oracle");
    }
  } catch {
    found.push("oracle");
  }
  if (checkSanityRules(result.query, { strictParentScope: true }).length > 0) found.push("sanity");
  const before = parse(fixture.query).functions.map((fn) => print({ ...fn.body }));
  const after = new Map(
    parse(result.query).functions.map((fn) => [`${fn.namespace}::${fn.name}`, print(fn.body)]),
  );
  parse(fixture.query).functions.forEach((fn, i) => {
    if (after.get(`${fn.namespace}::${fn.name}`) !== before[i]) found.push("existing declaration");
  });
  return found;
}

describe("legality rules", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.trap} (${fixture.rule})`, () => {
      expect(failures(fixture, false)).toEqual([]);
      expect(compile(fixture.query, { share: "documented", ...fixture.options }).query).not.toBe(
        undefined,
      );
      expect(failures(fixture, true)).toContain(fixture.fails);
    });
  }

  it("covers every rule", () => {
    const rules: ShareRule[] = [
      "traversal",
      "pipe",
      "parentheses",
      "parent-scope",
      "result-used-further",
      "shorthand-key",
      "parameter-name",
      "declaration-order",
      "existing-functions",
    ];
    expect(FIXTURES.map((f) => f.rule).toSorted()).toEqual(rules.toSorted());
  });
});
