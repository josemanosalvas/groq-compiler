import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readQueryRegistry, type RegistryQuery } from "../../src/typegen.js";
import { fixtureUrl } from "./fixtures.js";
import { privateCorpus } from "./paths.js";

/** Standalone page-builder query registry and seed dataset. */
export const pageBuilderQueries: RegistryQuery[] = JSON.parse(
  readFileSync(fixtureUrl("page-builder/queries.json"), "utf8"),
);

export const pageBuilderDataset: Record<string, unknown>[] = readFileSync(
  fixtureUrl("page-builder/dataset.ndjson"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

export const pageBuilderQuery = (name: string): string => {
  const entry = pageBuilderQueries.find((q) => q.name === name);
  if (!entry) throw new Error(`the page-builder corpus has no query named ${name}`);
  return entry.query;
};

/** Private corpus queries; empty (and tests skip) unless GROQ_COMPILER_PRIVATE_CORPUS points at the file. */
export const privateQueries: RegistryQuery[] =
  privateCorpus && existsSync(privateCorpus)
    ? readQueryRegistry(readFileSync(privateCorpus, "utf8"))
    : [];

export const privateQuery = (name: string): string => {
  const entry = privateQueries.find((q) => q.name === name);
  if (!entry) throw new Error(`the private corpus has no query named ${name}`);
  return entry.query;
};

export const describePrivate =
  privateQueries.length > 0
    ? "private corpus"
    : "private corpus (skipped: set GROQ_COMPILER_PRIVATE_CORPUS)";

export { join };
