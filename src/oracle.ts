// Oracle checks that need no dependency: the oracle itself (groq-js `parse`) is injected, so the core entry
// point stays dependency-free. `groq-compiler/verify` supplies groq-js.

/** Parses a query into a tree whose equality proves equal results: groq-js 2.0.0 `parse`. */
export type Oracle = (query: string) => unknown;

/** Structural equality of two JSON-like trees (plain objects, arrays and primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let count = 0;
  for (const key in left) {
    if (left[key] === undefined) continue;
    count++;
    if (!deepEqual(left[key], right[key])) return false;
  }
  for (const key in right) if (right[key] !== undefined) count--;
  return count === 0;
}

export type TreeCheck =
  | { status: "equal" }
  | { status: "different" }
  | { status: "invalid"; error: string };

/** Compares the oracle trees of a reference query (already parsed) and a candidate. */
export function checkTree(oracle: Oracle, reference: unknown, candidate: string): TreeCheck {
  let tree: unknown;
  try {
    tree = oracle(candidate);
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
  return deepEqual(reference, tree) ? { status: "equal" } : { status: "different" };
}
