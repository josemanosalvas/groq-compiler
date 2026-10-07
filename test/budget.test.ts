import { createClient } from "@sanity/client";
import { describe, expect, it } from "vitest";

import {
  budget,
  encodedQueryLength,
  encodeQueryString,
  formatBudget,
  GET_QUERY_LIMIT,
  requestMethod,
  type QueryParams,
} from "../src/budget.js";
import { compile, minify } from "../src/index.js";
import { privateQueries, pageBuilderQueries, pageBuilderQuery } from "./support/corpora.js";
import { seedParamSets } from "./support/seed.js";

interface Captured {
  method: string;
  search: string;
}

/** A real @sanity/client whose fetch records each request instead of sending it. */
function capturingClient() {
  const requests: Captured[] = [];
  const client = createClient({
    projectId: "abc123",
    dataset: "demo",
    apiVersion: "2026-09-01",
    useCdn: true,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", search: new URL(String(url)).search });
      return new Response(JSON.stringify({ result: null, ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  } as Parameters<typeof createClient>[0]);
  return { client, requests };
}

const PARAM_SETS: QueryParams[] = [
  {},
  { site: "brand-a", locale: "en", path: "/", defaultLocale: "en" },
  { site: "brand-b", locale: "de", path: "/katsushika-hokusai", defaultLocale: "en" },
  {
    path: "/café/👋?x=1&y=2",
    tags: ["a b", "c+d"],
    filter: { n: 1.5, ok: true },
    missing: undefined,
  },
];

async function matchesClient(query: string, params: QueryParams) {
  const { client, requests } = capturingClient();
  await client.fetch(query, params, { tag: "budget", perspective: "published" });
  const request = requests[0] as Captured;
  expect(request.method).toBe(requestMethod(query, params));
  if (request.method === "GET") {
    const ours = encodeQueryString({ query, params });
    expect(request.search.startsWith(ours)).toBe(true);
    expect(["&", undefined]).toContain(request.search[ours.length]);
    expect(ours.length).toBe(encodedQueryLength(query, params));
  }
}

describe("@sanity/client", () => {
  it("matches the client's encoding and method for every corpus query and parameter set", async () => {
    const queries = [
      ...pageBuilderQueries.map((q) => q.query),
      ...pageBuilderQueries.map(
        (q) => compile(q.query, { share: "with-params", nested: true }).query,
      ),
      ...privateQueries.map((q) => q.query),
      ...privateQueries.map((q) => compile(q.query, { share: "with-params", nested: true }).query),
    ];
    for (const query of queries) {
      for (const params of PARAM_SETS) await matchesClient(query, params);
    }
  });

  it("switches to POST exactly at the limit", async () => {
    for (const params of PARAM_SETS) {
      const base = encodedQueryLength('""', params);
      for (const target of [
        GET_QUERY_LIMIT - 2,
        GET_QUERY_LIMIT - 1,
        GET_QUERY_LIMIT,
        GET_QUERY_LIMIT + 1,
      ]) {
        const query = `"${"a".repeat(target - base)}"`;
        expect(encodedQueryLength(query, params)).toBe(target);
        expect(requestMethod(query, params)).toBe(target < GET_QUERY_LIMIT ? "GET" : "POST");
        await matchesClient(query, params);
      }
    }
  });

  it("encodes options like the client", () => {
    expect(
      encodeQueryString({
        query: "*",
        params: { a: 1 },
        options: {
          tag: "t",
          returnQuery: false,
          includeMutations: false,
          perspective: "drafts",
          empty: "",
        },
      }),
    ).toBe("?tag=t&query=*&%24a=1&perspective=drafts&returnQuery=false&includeMutations=false");
  });
});

describe("report", () => {
  // Historical size limits include `&returnQuery=false` (17 characters), which the client
  // adds only after choosing the request method.
  it("reproduces the pageQuery budget: minified is POST, compiled is GET", () => {
    const query = pageBuilderQuery("pageQuery");
    const compiled = compile(query, { share: "with-params", nested: true }).query;
    for (const params of seedParamSets["pageQuery"] ?? []) {
      const [minifiedEntry, compiledEntry] = budget([
        { name: "minified", query: minify(query), params },
        { name: "compiled", query: compiled, params },
      ]);
      expect(minifiedEntry?.method).toBe("POST");
      expect(minifiedEntry?.encoded).toBeGreaterThanOrEqual(18_819 - 17 - 17);
      expect(compiledEntry?.method).toBe("GET");
      expect(compiledEntry?.encoded).toBeLessThanOrEqual(6_612 - 17 + 1);
    }
  });

  it("formats a table naming queries over the budget", () => {
    const entries = budget([
      { name: "small", query: "*[0]" },
      { name: "big", query: `"${"x".repeat(GET_QUERY_LIMIT)}"` },
    ]);
    expect(entries.map((e) => [e.name, e.method, e.margin > 0])).toEqual([
      ["small", "GET", true],
      ["big", "POST", false],
    ]);
    const text = formatBudget(entries);
    expect(text).toContain("1/2 queries fit the GET budget; over it: big.");
    expect(text.split("\n")[1]).toMatch(/^big/);
  });
});
