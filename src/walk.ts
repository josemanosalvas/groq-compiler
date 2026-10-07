import type { Node, ObjectLiteral, Program } from "./ast.js";

/** Calls `visit` with every direct child expression of `node`, in source order. */
export function forEachChild(node: Node, visit: (child: Node) => void): void {
  switch (node.type) {
    case "Everything":
    case "This":
    case "Parent":
    case "Identifier":
    case "String":
    case "Number":
    case "Parameter":
      return;
    case "Group":
      visit(node.expr);
      return;
    case "Tuple":
      node.members.forEach(visit);
      return;
    case "Array":
      for (const element of node.elements) visit(element.value);
      return;
    case "Object":
      forEachMemberValue(node, visit);
      return;
    case "Prefix":
      visit(node.expr);
      return;
    case "Binary":
    case "Pair":
      visit(node.left);
      visit(node.right);
      return;
    case "InRange":
      visit(node.left);
      visit(node.low);
      visit(node.high);
      return;
    case "Order":
      visit(node.expr);
      return;
    case "Call":
      node.args.forEach(visit);
      return;
    case "Pipe":
      visit(node.base);
      visit(node.call);
      return;
    case "Attribute":
    case "ArrayPostfix":
    case "Deref":
      visit(node.base);
      return;
    case "Bracket":
      visit(node.base);
      visit(node.expr);
      return;
    case "Slice":
      visit(node.base);
      visit(node.low);
      visit(node.high);
      return;
    case "Projection":
      visit(node.base);
      visit(node.object);
      return;
  }
}

function forEachMemberValue(object: ObjectLiteral, visit: (child: Node) => void): void {
  for (const member of object.members) {
    if (member.type === "Keyed") visit(member.key);
    if (member.value) visit(member.value);
  }
}

/** Visits `node` and all its descendants depth-first, parents before children. */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => walk(child, visit));
}

/** Visits the query body and, unless `declarations` is false, every function declaration body. */
export function walkProgram(
  program: Program,
  visit: (node: Node) => void,
  { declarations = true }: { declarations?: boolean } = {},
): void {
  if (declarations) for (const fn of program.functions) walk(fn.body, visit);
  walk(program.body, visit);
}
