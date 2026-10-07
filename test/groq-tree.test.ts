import { parse as groqParse } from "groq-js";
import { describe, expect, it } from "vitest";

import type { Node } from "../src/ast.js";
import { GroqTreeBuilder, type GroqNode } from "../src/groq-tree.js";
import { parse } from "../src/parser.js";
import { walk } from "../src/walk.js";

/** Converts `query` with every object literal replaced by an opaque leaf. */
function withOpaqueObjects(query: string): GroqNode {
  const { body } = parse(query);
  const objects = new Set<Node>();
  walk(body, (node) => node.type === "Object" && objects.add(node));
  const builder = new GroqTreeBuilder([], {
    opaque: (node) => (objects.has(node) ? { type: "Opaque" } : undefined),
  });
  return builder.convert(body);
}

describe("opaque leaves", () => {
  it("replace the object of a projection in a traversal chain", () => {
    expect(groqParse("a[]{b}")).toEqual({
      type: "Map",
      base: { type: "ArrayCoerce", base: { type: "AccessAttribute", name: "a" } },
      expr: { type: "Projection", base: { type: "This" }, expr: expect.anything() },
    });
    expect(withOpaqueObjects("a[]{b}")).toEqual({
      type: "Map",
      base: { type: "ArrayCoerce", base: { type: "AccessAttribute", name: "a" } },
      expr: { type: "Projection", base: { type: "This" }, expr: { type: "Opaque" } },
    });
  });

  it("replace an object literal outside a projection", () => {
    expect(withOpaqueObjects("[{a}]")).toEqual({
      type: "Array",
      elements: [{ type: "ArrayElement", value: { type: "Opaque" }, isSplat: false }],
    });
  });
});
