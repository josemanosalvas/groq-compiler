import { evaluate, parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import { GET_QUERY_LIMIT } from "../src/budget.js";
import {
  fetchSplit,
  neededQueries,
  split,
  splitBudget,
  SplitError,
  stitch,
  StitchError,
  toPlan,
  type SplitPlan,
} from "../src/split.js";
import {
  describePrivate,
  privateQueries,
  privateQuery,
  pageBuilderDataset,
  pageBuilderQuery,
} from "./support/corpora.js";
import { seedParamSets } from "./support/seed.js";

type Params = Record<string, unknown>;

const runner =
  (dataset: unknown[]) =>
  async (query: string, params: Params): Promise<unknown> =>
    (await evaluate(groqParse(query), { dataset, params })).get();

describe("page-builder pageQuery", () => {
  const query = pageBuilderQuery("pageQuery");
  const run = runner(pageBuilderDataset);

  for (const [label, compile] of [
    ["default compile", {}],
    ["with-params + nested", { share: "with-params", nested: true }],
  ] as const) {
    it(`stitched results equal the monolithic results for every seed page (${label})`, async () => {
      const plan = toPlan(split(query, { compile }));
      const pages = seedParamSets["pageQuery"] ?? [];
      expect(pages).toHaveLength(11);
      for (const params of pages) {
        expect(await fetchSplit(plan, run, params), JSON.stringify(params)).toEqual(
          await run(query, params),
        );
      }
    });
  }

  it("fits every block type in the GET budget (baseline: 10/10, largest 3,362 with returnQuery)", () => {
    const result = split(query, { compile: { share: "with-params", nested: true } });
    expect(result.root.types).toHaveLength(10);
    expect(Object.keys(result.queries)).toHaveLength(11); // ten types and "other"
    const params = {
      site: "brand-b",
      locale: "de",
      path: "/katsushika-hokusai",
      defaultLocale: "en",
    };
    const entries = splitBudget(result, params);
    expect(entries.every((e) => e.method === "GET")).toBe(true);
    const blocks = entries.filter((e) => e.name !== "outline");
    expect(Math.max(...blocks.map((e) => e.encoded))).toBeLessThanOrEqual(3_362 - 17);
    for (const detail of result.details) expect(detail.compile.fallback).toBeUndefined();
  });

  it("fetches only the queries a page needs", async () => {
    const plan = split(query);
    const params = seedParamSets["pageQuery"]?.[1] as Params;
    const outline = await run(plan.outline, params);
    const ids = neededQueries(plan, outline);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(Object.keys(plan.queries).length);
    const missing = await run(plan.outline, { ...params, path: "/no-such-page" });
    expect(missing).toBeNull();
    expect(neededQueries(plan, missing)).toEqual([]);
  });
});

// A page builder with a match group, a combined condition, an unknown type, `^` at two levels, and
// containers two levels deep.
const DATASET = [
  {
    _id: "p1",
    _type: "page",
    slug: "home",
    title: "Home",
    blocks: [
      { _key: "a", _type: "hero.text", heading: "H", cta: { label: "Go" } },
      { _key: "b", _type: "hero.image", image: { url: "/i.png" } },
      { _key: "c", _type: "text", body: "x", ref: { _ref: "ann" } },
      { _key: "d", _type: "quote", quote: "q" },
      { _key: "e", _type: "callout", note: "n" },
      {
        _key: "f",
        _type: "tabs",
        tabs: [
          {
            _key: "t1",
            label: "One",
            modules: [
              { _key: "m1", _type: "text", body: "inner" },
              { _key: "m2", _type: "quote", quote: "q2" },
              { _key: "m3", _type: "mystery" },
              {
                _key: "m4",
                _type: "accordion",
                items: [
                  {
                    _key: "i1",
                    title: "Q",
                    content: [
                      { _key: "c1", _type: "text", body: "deep" },
                      { _key: "c2", _type: "img" },
                    ],
                  },
                ],
              },
            ],
          },
          { _key: "t2", label: "Two", modules: [{ _key: "m5", _type: "text", body: "second" }] },
          { _key: "t3", label: "Empty" },
        ],
      },
      { _key: "g", _type: "mystery", foo: 1 },
      { _key: "h", _type: "text", body: "y" },
      { _key: "i", _type: "hidden" },
      {
        _key: "j",
        _type: "tabs",
        tabs: [
          { _key: "t4", label: "Solo", modules: [{ _key: "m6", _type: "quote", quote: "q3" }] },
        ],
      },
    ],
  },
  { _id: "ann", _type: "author", name: "Ann" },
];

const SYNTHETIC = `*[_type == "page" && slug == $slug][0]{
  title,
  "blocks": blocks[_type != "hidden"]{
    ...,
    _type match "hero.*" => {
      "kind": "hero",
      _type == "hero.text" => { heading, "label": cta.label },
      _type == "hero.image" => { "src": image.url },
    },
    _type == "text" => { body, "author": ref->name, "pageTitle": ^.title },
    (_type == "quote" || _type == "callout") => { "highlight": true },
    _type == "tabs" => {
      tabs[]{
        label,
        modules[]{
          ...,
          _type == "text" => { body, "tab": ^.label },
          _type == "quote" => { quote },
          _type == "accordion" => {
            items[]{
              title,
              content[]{ ..., _type == "text" => { "item": ^.title, body } }
            }
          }
        }
      }
    },
  },
}`;

describe("synthetic page builder", () => {
  const run = runner(DATASET);

  it("splits match groups, combined conditions and containers, and stitches the same result", async () => {
    const plan = split(SYNTHETIC, { containers: ["tabs", "accordion"] });
    expect(plan.root.types.toSorted()).toEqual(
      ["callout", "hero.image", "hero.text", "quote", "tabs", "text"].toSorted(),
    );
    const tabs = plan.root.containers["tabs"]?.[0];
    expect(tabs?.path).toEqual(["tabs", "modules"]);
    expect(tabs?.containers["accordion"]?.[0]?.path).toEqual(["items", "content"]);
    for (const params of [{ slug: "home" }, { slug: "missing" }]) {
      expect(await fetchSplit(plan, run, params)).toEqual(await run(SYNTHETIC, params));
    }
    const outline = await run(plan.outline, { slug: "home" });
    expect(neededQueries(plan, outline)).toEqual(
      expect.arrayContaining([
        "blocks#*",
        "blocks#tabs",
        "blocks>tabs:tabs.modules#text",
        "blocks>tabs:tabs.modules#*",
        "blocks>tabs:tabs.modules>accordion:items.content#text",
        "blocks>tabs:tabs.modules>accordion:items.content#*",
      ]),
    );
  });

  it("keeps nested lists inline without containers", async () => {
    const plan = split(SYNTHETIC, { containers: "none" });
    expect(plan.root.containers).toEqual({});
    expect(await fetchSplit(plan, run, { slug: "home" })).toEqual(
      await run(SYNTHETIC, { slug: "home" }),
    );
  });

  it("splits containers automatically only when their query is over budget", () => {
    expect(split(SYNTHETIC).root.containers).toEqual({});
  });

  it("drops branches that cannot apply to a type", () => {
    const plan = split(SYNTHETIC, { containers: "none", compile: { share: "off" } });
    expect(plan.queries["blocks#hero.text"]).toContain('"kind":"hero"');
    expect(plan.queries["blocks#hero.text"]).not.toContain("hero.image");
    expect(plan.queries["blocks#quote"]).toContain('"highlight":true');
    expect(plan.queries["blocks#callout"]).toContain('"highlight":true');
    expect(plan.queries["blocks#text"]).not.toContain("highlight");
    expect(plan.queries["blocks#*"]).toContain('!(_type in["hero.text"');
    expect(plan.queries["blocks#*"]).toContain('match"hero.*"');
  });

  it("detects mismatched results and falls back to the monolithic query", async () => {
    const plan: SplitPlan = toPlan(split(SYNTHETIC, { containers: "none" }));
    const outline = await run(plan.outline, { slug: "home" });
    const text = (await run(plan.queries["blocks#text"] as string, { slug: "home" })) as unknown[];
    expect(() => stitch(plan, outline, { "blocks#text": text.slice(1) })).toThrow(StitchError);
    let calls = 0;
    const stale = async (query: string, params: Params) => {
      calls++;
      const value = await run(query, params);
      return query === plan.queries["blocks#text"] ? (value as unknown[]).slice(1) : value;
    };
    const result = await fetchSplit(plan, stale, { slug: "home" }, SYNTHETIC);
    expect(result).toEqual(await run(SYNTHETIC, { slug: "home" }));
    expect(calls).toBeGreaterThan(2);
  });

  it("rejects queries without a single page and a block list", () => {
    expect(() => split('*[_type == "page"]{blocks[]{_type == "a" => {b}}}')).toThrow(SplitError);
    expect(() => split('*[_type == "page"][0]{title}')).toThrow(SplitError);
    expect(() => split('*[0]{"x": blocks[]{_type == "a" => {b}}}', { blocks: "y" })).toThrow(
      SplitError,
    );
  });
});

describe.skipIf(privateQueries.length === 0)(describePrivate, () => {
  it("reproduces the per-type budget: the tab container splits, the comparison block stays over", () => {
    const result = split(privateQuery("PAGE_QUERY"), {
      compile: { share: "with-params", nested: true },
    });
    const entries = splitBudget(result);
    const over = entries.filter((e) => e.method === "POST").map((e) => e.name);
    const top = entries.filter((e) => e.name.startsWith(`${result.root.id}#`));
    const nested = entries.filter((e) => e.name.includes(">"));
    const containers = Object.keys(result.root.containers);
    process.stdout.write(
      `Private PAGE_QUERY split: ${top.length - top.filter((e) => e.method === "POST").length}/${top.length} top-level and ` +
        `${nested.length - nested.filter((e) => e.method === "POST").length}/${nested.length} nested queries under the budget; ` +
        `${containers.length} container split again; over: ${over.length} (outline, comparison block twice).\n`,
    );
    expect(containers).toHaveLength(1);
    expect(top.filter((e) => e.method === "POST")).toHaveLength(1);
    expect(nested.filter((e) => e.method === "POST")).toHaveLength(1);
    expect(over).toContain("outline");
    expect(over).toHaveLength(3);
    for (const entry of entries)
      if (entry.method === "POST") expect(entry.encoded).toBeGreaterThanOrEqual(GET_QUERY_LIMIT);
    for (const detail of result.details) expect(detail.compile.fallback).toBeUndefined();
  });
});
