import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import { compile, type CompileOptions } from "../src/index.js";
import { parse } from "../src/parser.js";
import { checkSanityRules } from "../src/sanity-rules.js";
import { walk } from "../src/walk.js";
import {
  describePrivate,
  privateQueries,
  privateQuery,
  pageBuilderQueries,
  pageBuilderQuery,
} from "./support/corpora.js";
import { runSeed, seedParamSets } from "./support/seed.js";

const CONFIGS: [label: string, options: CompileOptions][] = [
  ["documented", { share: "documented" }],
  ["documented + nested", { share: "documented", nested: true }],
  ["with-params", { share: "with-params" }],
  ["with-params + nested", { share: "with-params", nested: true }],
  ["with-params + nested, url cost", { share: "with-params", nested: true, cost: "url" }],
  ["with-params + nested + mangle", { share: "with-params", nested: true, mangle: true }],
];

const encoded = (q: string) => new URLSearchParams({ q }).toString().length - 2;

const finalBytes = (query: string, options: CompileOptions) =>
  compile(query, options).report.steps.at(-1)?.bytes;

/** Compiles, checks the oracle and Sanity's function rules, and returns the result. */
function compileChecked(query: string, options: CompileOptions) {
  const result = compile(query, options);
  expect(result.fallback).toBeUndefined();
  expect(groqParse(result.query)).toEqual(groqParse(query));
  expect(checkSanityRules(result.query)).toEqual([]);
  if (options.share === "documented") {
    expect(result.functions.filter((f) => f.usesParams)).toEqual([]);
  }
  if (!options.nested) expect(result.functions.filter((f) => f.callsFunctions)).toEqual([]);
  // Generated bodies never use ^ at all.
  const generated = new Set(result.functions.map((f) => f.name));
  for (const fn of parse(result.query).functions) {
    if (!generated.has(`${fn.namespace}::${fn.name}`)) continue;
    walk(fn.body, (node) => expect(node.type, `${fn.namespace}::${fn.name}`).not.toBe("Parent"));
  }
  return result;
}

describe("baselines", () => {
  it("page-builder pageQuery", () => {
    const query = pageBuilderQuery("pageQuery");
    expect(finalBytes(query, { share: "documented" })).toBeLessThanOrEqual(11_410);
    expect(finalBytes(query, { share: "with-params" })).toBeLessThanOrEqual(5_243);
    expect(finalBytes(query, { share: "with-params", nested: true })).toBeLessThanOrEqual(4_340);
  });

  it("page-builder settingsQuery", () => {
    expect(finalBytes(pageBuilderQuery("settingsQuery"), {})).toBeLessThanOrEqual(670);
  });

  // These size limits include calls to existing custom functions, so nested sharing is enabled.
  describe.skipIf(privateQueries.length === 0)(describePrivate, () => {
    for (const [name, documented, withParams] of [
      ["PAGE_QUERY", 107_426, 78_487],
      ["TYPED_BLOCK_QUERY", 93_802, 66_157],
      ["PAGE_SHELL_QUERY", 17_515, 16_829],
    ] as const) {
      it(name, () => {
        const query = privateQuery(name);
        expect(finalBytes(query, { share: "documented", nested: true })).toBeLessThanOrEqual(
          documented,
        );
        expect(finalBytes(query, { share: "with-params", nested: true })).toBeLessThanOrEqual(
          withParams,
        );
      });
    }
  });
});

describe("oracle and Sanity rules", () => {
  for (const [label, options] of CONFIGS) {
    it(`page-builder, ${label}`, () => {
      for (const { query } of pageBuilderQueries) compileChecked(query, options);
    });
  }

  describe.skipIf(privateQueries.length === 0)(describePrivate, () => {
    for (const [label, options] of CONFIGS) {
      it(label, () => {
        for (const { query } of privateQueries) compileChecked(query, options);
      });
    }
  });
});

describe("page-builder seed dataset", () => {
  for (const [label, options] of CONFIGS) {
    it(`identical results, ${label}`, async () => {
      for (const { name, query } of pageBuilderQueries) {
        const compiled = compile(query, options).query;
        const paramSets = seedParamSets[name] ?? [{}];
        expect(paramSets.length).toBeGreaterThan(0);
        for (const params of paramSets) {
          expect(await runSeed(compiled, params), `${name} ${JSON.stringify(params)}`).toEqual(
            await runSeed(query, params),
          );
        }
      }
    });
  }

  it("covers every seeded page and a missing one", () => {
    expect(seedParamSets["pageQuery"]).toHaveLength(11);
  });
});

const BIG = '"a": a, "b": b->{_id, title}, "c": c[]{_key, value}, "d": coalesce(d, "none")';

describe("sites", () => {
  it("shares each body form and calls with the base", () => {
    const query = `*[0]{"p": p{${BIG}}, "q": q{${BIG}}, "r": r->{${BIG}}, "s": s->{${BIG}}, "t": t[]{${BIG}}, "u": u[]{${BIG}}, "v": v[]->{${BIG}}, "w": w[]->{${BIG}}}`;
    const result = compileChecked(query, { share: "documented" });
    expect(result.functions.map((f) => f.form).toSorted()).toEqual([
      "array",
      "array-deref",
      "deref",
      "projection",
    ]);
    expect(result.query).toContain('"p":f::');
    expect(result.query).toMatch(/fn f::\w\(\$a\)=\$a\[\]->\{/);
  });

  it("adds an explicit key for shorthand members", () => {
    const result = compileChecked(`*[0]{image{${BIG}}, "other": other{${BIG}}}`, {});
    expect(result.functions).toHaveLength(1);
    expect(result.query).toContain('"image":f::a(image)');
  });

  it("shares element access and plain chains, which keep their tree", () => {
    const result = compileChecked(
      `{"x": a[0]{${BIG}}, "y": b.c{${BIG}}, "z": (d[].e){${BIG}}}`,
      {},
    );
    expect(result.functions[0]?.uses).toBe(3);
    expect(result.query).toContain("f::a((d[].e))");
  });

  it("picks a parameter name the query does not use", () => {
    const result = compileChecked(
      `*[_type == $a]{"x": x{${BIG}, "s": $b}, "y": y{${BIG}, "s": $b}}`,
      { share: "with-params" },
    );
    expect(result.query).toMatch(/fn f::a\(\$c\)=\$c\{/);
  });

  it("keeps bodies free of query parameters in documented mode", () => {
    const query = `*[0]{"x": x{${BIG}, "s": $site}, "y": y{${BIG}, "s": $site}}`;
    expect(compile(query, { share: "documented" }).functions).toHaveLength(0);
    expect(compileChecked(query, { share: "with-params" }).functions[0]?.usesParams).toBe(true);
  });

  it("declares callees before callers and removes unused declarations", () => {
    const inner = `{${BIG}}`;
    const query = `fn old::unused($x) = $x{a}; *[0]{"x": x{"i": i${inner}, "j": j${inner}, "k": 1}, "y": y{"i": i${inner}, "j": j${inner}, "k": 1}}`;
    const result = compileChecked(query, { share: "with-params", nested: true });
    expect(result.report.removedFunctions).toEqual(["old::unused"]);
    expect(result.functions.some((f) => f.callsFunctions)).toBe(true);
  });

  it("leaves existing declarations untouched and calls them from bodies when nested", () => {
    const query = `fn link::href($l) = $l{"href": coalesce(url, slug.current)}; *[0]{"x": x{${BIG}, "l": link::href(l)}, "y": y{${BIG}, "l": link::href(l)}}`;
    expect(compile(query, { share: "documented" }).functions).toHaveLength(0);
    const result = compileChecked(query, { share: "documented", nested: true });
    expect(
      result.query.startsWith('fn link::href($l)=$l{"href":coalesce(url,slug.current)};'),
    ).toBe(true);
    expect(result.functions).toHaveLength(1);
  });

  it("mangles existing functions and their parameters", () => {
    const query = `fn link::href($link) = $link{"href": coalesce(url, slug.current)}; *[0]{"x": link::href(x), "y": link::href(y)}`;
    const result = compileChecked(query, { mangle: true });
    expect(result.report.renamedFunctions).toEqual({ "link::href": "f::a" });
    expect(result.query).toBe(
      'fn f::a($a)=$a{"href":coalesce(url,slug.current)};*[0]{"x":f::a(x),"y":f::a(y)}',
    );
  });

  it("scores sharing by encoded length with the url cost model", () => {
    const query = pageBuilderQuery("pageQuery");
    const bytes = compile(query, { share: "with-params", nested: true });
    const url = compile(query, { share: "with-params", nested: true, cost: "url" });
    expect(encoded(url.query)).toBeLessThanOrEqual(encoded(bytes.query));
  });
});
