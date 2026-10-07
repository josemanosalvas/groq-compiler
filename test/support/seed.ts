import { evaluate, parse } from "groq-js";

import { pageBuilderDataset } from "./corpora.js";

type Params = Record<string, unknown>;
type Doc = Record<string, unknown> & { _id: string; _type: string };

// Both fixture sites use English as their default locale.
const DEFAULT_LOCALE: Record<string, string> = { "brand-a": "en", "brand-b": "en" };
const docs = pageBuilderDataset as Doc[];
const ofType = (type: string) => docs.filter((d) => d._type === type);

const pages: Params[] = ofType("page").map((d) => ({
  site: d["site"],
  locale: d["language"],
  path: (d["slug"] as { current: string }).current,
  defaultLocale: DEFAULT_LOCALE[d["site"] as string],
}));
pages.push({ site: "brand-a", locale: "en", path: "/no-such-page", defaultLocale: "en" });

const singletons = (type: string): Params[] =>
  ofType(type).map((d) => ({
    id: d._id,
    site: d["site"],
    locale: d["language"] ?? DEFAULT_LOCALE[d["site"] as string],
    defaultLocale: DEFAULT_LOCALE[d["site"] as string],
  }));

/** Parameter sets for the page-builder corpus: each seeded page plus a missing page, each singleton. */
export const seedParamSets: Record<string, Params[]> = {
  pageQuery: pages,
  pageMetadataQuery: pages,
  pagePathsQuery: [{}],
  sitemapQuery: Object.keys(DEFAULT_LOCALE).map((site) => ({ site })),
  navigationQuery: singletons("navigation"),
  footerQuery: singletons("footer"),
  settingsQuery: singletons("settings"),
  redirectsQuery: [{}],
};

/** Evaluates a query against the seed dataset with groq-js. */
export async function runSeed(query: string, params: Params): Promise<unknown> {
  return (await evaluate(parse(query), { dataset: docs, params })).get();
}
