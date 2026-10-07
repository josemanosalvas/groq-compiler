// Sanity's documented rules for custom GROQ functions, which groq-js does not all enforce
// (https://www.sanity.io/docs/content-lake/custom-groq-functions): one parameter; bodies `$p{…}`,
// `$p->{…}`, `$p[]{…}` or `$p[]->{…}`; the parameter used once; no parent scope `^`; no recursion.
// A `^` that stays inside scopes the body opens itself (`$p{"x": *[references(^._id)]}`) is accepted by
// the real API (findings, "Real backend"), so only a `^` reaching the caller's scope is a violation;
// pass `strictParentScope` to reject every `^`, as the share pass does for the bodies it generates.
// Plus the conventions the compiler keeps: callees declared before callers, and calls never used as
// shorthand object members (their key would come from expanding the call).
import { isTraversal, type FunctionDeclaration, type Node, type Program } from "./ast.js";
import { parse } from "./parser.js";
import { forEachChild, walk } from "./walk.js";

export interface SanityRuleOptions {
  /** Also reject query parameters in bodies and calls between functions (the documented subset). */
  documentedOnly?: boolean;
  /** Reject every `^` in a body, not only one that reaches the caller's scope. */
  strictParentScope?: boolean;
}

const BUILT_IN = new Set([
  "array",
  "dateTime",
  "delta",
  "diff",
  "documents",
  "geo",
  "math",
  "media",
  "pt",
  "releases",
  "sanity",
  "string",
  "text",
  "user",
]);

const id = (fn: FunctionDeclaration) => `${fn.namespace}::${fn.name}`;

function bodyParameter(body: Node): string | undefined {
  if (body.type !== "Projection" || body.pipe) return undefined;
  let base = body.base;
  if (base.type === "Deref" && base.attr === null) base = base.base;
  if (base.type === "ArrayPostfix") base = base.base;
  return base.type === "Parameter" ? base.name : undefined;
}

/** Whether a `^` in the body reaches the caller's scope: scopes open at projections and filters. */
function escapingParent(body: Node, strict: boolean): boolean {
  const visit = (node: Node, level: number): boolean => {
    if (node.type === "Parent") return strict || node.levels >= level;
    if (node.type === "Projection") return visit(node.base, level) || visit(node.object, level + 1);
    if (node.type === "Bracket") return visit(node.base, level) || visit(node.expr, level + 1);
    let found = false;
    forEachChild(node, (child) => {
      found ||= visit(child, level);
    });
    return found;
  };
  return visit(body, 0);
}

/** The custom function calls on a shorthand member's key path, which Sanity cannot derive a key from. */
function keyPathCall(value: Node, declared: ReadonlySet<string>): string | undefined {
  for (let node = value; ;) {
    if (node.type === "Call") {
      const name = `${node.namespace ?? "global"}::${node.name}`;
      return declared.has(name) ? name : undefined;
    }
    if (isTraversal(node) || node.type === "Pipe") node = node.base;
    else if (node.type === "Group") node = node.expr;
    else return undefined;
  }
}

/** Violations of Sanity's custom function rules in a query; empty when it complies. */
export function checkSanityRules(
  query: string | Program,
  options: SanityRuleOptions = {},
): string[] {
  const program = typeof query === "string" ? parse(query) : query;
  const violations: string[] = [];
  const declared = new Set(program.functions.map(id));
  const position = new Map(program.functions.map((fn, i) => [id(fn), i]));
  const callees = new Map<string, string[]>();
  for (const [i, fn] of program.functions.entries()) {
    const name = id(fn);
    if (fn.params.length !== 1) violations.push(`${name}: takes ${fn.params.length} parameters`);
    const param = fn.params[0];
    if (bodyParameter(fn.body) !== param) {
      violations.push(`${name}: body is not $p{…}, $p->{…}, $p[]{…} or $p[]->{…}`);
    }
    let uses = 0;
    const calls: string[] = [];
    walk(fn.body, (node) => {
      if (node.type === "Parameter" && node.name === param) uses++;
      if (node.type === "Parameter" && node.name !== param && options.documentedOnly) {
        violations.push(`${name}: reads the query parameter $${node.name}`);
      }
      if (node.type === "Call" && node.namespace !== null) {
        const callee = `${node.namespace}::${node.name}`;
        if (declared.has(callee)) calls.push(callee);
      }
    });
    if (uses !== 1) violations.push(`${name}: uses its parameter ${uses} times`);
    if (escapingParent(fn.body, options.strictParentScope ?? false)) {
      violations.push(`${name}: uses the parent scope ^`);
    }
    for (const callee of calls) {
      if (options.documentedOnly) violations.push(`${name}: calls ${callee}`);
      if ((position.get(callee) as number) >= i) {
        violations.push(`${name}: calls ${callee}, which is declared after it`);
      }
    }
    callees.set(name, calls);
  }
  // Recursion: a cycle in the call graph.
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): boolean => {
    if (state.get(name) === "visiting") return true;
    if (state.get(name) === "done") return false;
    state.set(name, "visiting");
    const cyclic = (callees.get(name) ?? []).some(visit);
    state.set(name, "done");
    return cyclic;
  };
  for (const name of declared) if (visit(name)) violations.push(`${name}: is recursive`);
  const roots = [program.body, ...program.functions.map((fn) => fn.body)];
  for (const root of roots) {
    walk(root, (node) => {
      if (node.type === "Call" && node.namespace !== null && !BUILT_IN.has(node.namespace)) {
        const callee = `${node.namespace}::${node.name}`;
        if (!declared.has(callee)) violations.push(`${callee}: is called but not declared`);
      }
      if (node.type !== "Object") return;
      for (const member of node.members) {
        if (member.type !== "Expression") continue;
        const call = keyPathCall(member.value, declared);
        if (call)
          violations.push(`${call}: called as a shorthand member, which needs an explicit key`);
      }
    });
  }
  return [...new Set(violations)];
}
