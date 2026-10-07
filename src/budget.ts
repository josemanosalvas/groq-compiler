// groq-compiler/budget: the GET budget of @sanity/client. The client URL-encodes `{ query, params }` and sends
// a GET when that query string is shorter than 11,264 characters, a POST otherwise. Request options (tag,
// perspective, returnQuery …) are appended to the URL afterwards and do not count.
// Source: `_dataRequestOptions` and `encodeQueryString` in @sanity/client 7.27 and 8.x `dist/index.js`.
import { utf8Length } from "./lexer.js";

/** `@sanity/client` sends a query as GET only when its encoded query string is shorter than this. */
export const GET_QUERY_LIMIT = 11_264;

export type QueryParams = Record<string, unknown>;

export interface QueryRequest {
  query: string;
  params?: QueryParams;
  /** Client options as `encodeQueryString` handles them; the GET decision passes none. */
  options?: Record<string, unknown>;
}

/** `encodeQueryString` exactly as `@sanity/client` implements it. */
export function encodeQueryString({ query, params = {}, options = {} }: QueryRequest): string {
  const searchParams = new URLSearchParams();
  const { tag, includeMutations, returnQuery, ...opts } = options;
  if (tag) searchParams.append("tag", String(tag));
  searchParams.append("query", query);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.append(`$${key}`, JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(opts)) {
    if (value) searchParams.append(key, `${value as string}`);
  }
  if (returnQuery === false) searchParams.append("returnQuery", "false");
  if (includeMutations === false) searchParams.append("includeMutations", "false");
  return `?${searchParams}`;
}

/** The length `@sanity/client` compares with `GET_QUERY_LIMIT`. */
export const encodedQueryLength = (query: string, params: QueryParams = {}): number =>
  encodeQueryString({ query, params }).length;

/** The method `@sanity/client` uses for a query. */
export const requestMethod = (query: string, params: QueryParams = {}): "GET" | "POST" =>
  encodedQueryLength(query, params) < GET_QUERY_LIMIT ? "GET" : "POST";

export interface BudgetEntry {
  name: string;
  /** UTF-8 bytes of the query. */
  bytes: number;
  /** Encoded length of the query string, parameters included. */
  encoded: number;
  method: "GET" | "POST";
  /** Characters left under the limit; zero or negative means POST. */
  margin: number;
}

export interface BudgetInput {
  name: string;
  query: string;
  params?: QueryParams;
}

/** Budget of each query. */
export function budget(queries: readonly BudgetInput[]): BudgetEntry[] {
  return queries.map(({ name, query, params = {} }) => {
    const encoded = encodedQueryLength(query, params);
    return {
      name,
      bytes: utf8Length(query),
      encoded,
      method: encoded < GET_QUERY_LIMIT ? "GET" : "POST",
      margin: GET_QUERY_LIMIT - encoded,
    };
  });
}

const column = (n: number) => n.toLocaleString("en").padStart(9);

/** Plain-text table of budget entries, largest first. */
export function formatBudget(entries: readonly BudgetEntry[]): string {
  const rows = [...entries].toSorted((a, b) => b.encoded - a.encoded);
  const name = Math.max(4, ...rows.map((r) => r.name.length));
  const lines = [
    `${"Query".padEnd(name)}     bytes   encoded  method    margin`,
    ...rows.map(
      (r) =>
        `${r.name.padEnd(name)} ${column(r.bytes)} ${column(r.encoded)}  ${r.method.padEnd(6)}${column(r.margin)}`,
    ),
  ];
  const over = rows.filter((r) => r.method === "POST");
  lines.push(
    "",
    over.length === 0
      ? `All ${rows.length} queries fit the GET budget (${GET_QUERY_LIMIT.toLocaleString("en")} characters).`
      : `${rows.length - over.length}/${rows.length} queries fit the GET budget; over it: ${over.map((r) => r.name).join(", ")}.`,
  );
  return lines.join("\n");
}
