// Tidy pass: drops trailing commas and writes `"x": x` and `"x": x->` as the shorthand members `x` and `x->`.
// groq-js gives both spellings the same tree. Existing function declarations stay untouched.
import { KEYWORD_VALUES, type Node, type Program } from "./ast.js";
import { walk } from "./walk.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The identifier `value` reads, when it is `name` or `name->`; the shorthand key it implies. */
function shorthandName(value: Node): string | undefined {
  if (value.type === "Identifier") return value.name;
  if (value.type === "Deref" && value.attr === null && value.base.type === "Identifier") {
    return value.base.name;
  }
  return undefined;
}

/** Applies the tidy pass in place; returns the number of rewrites. */
export function tidy(program: Program): number {
  let rewrites = 0;
  walk(program.body, (node) => {
    switch (node.type) {
      case "Array":
      case "Object":
      case "Call":
        if (node.trailingComma) {
          node.trailingComma = false;
          rewrites++;
        }
        break;
      default:
        break;
    }
    if (node.type !== "Object") return;
    node.members = node.members.map((member) => {
      if (member.type !== "Keyed") return member;
      const key = member.key.value;
      if (!IDENTIFIER.test(key) || KEYWORD_VALUES.has(key) || shorthandName(member.value) !== key) {
        return member;
      }
      rewrites++;
      return { type: "Expression", value: member.value, start: member.start, end: member.end };
    });
  });
  return rewrites;
}
