// groq-compiler/split: splits a page-builder query into an outline query and one constant query per block
// type, so each fits the GET budget, and stitches the results back into the monolithic shape.
//
// The outline is the page query with every block list replaced by `{_key, _type}` items, container children
// included. A block-type query keeps the page projection around its block list, so `^` inside a block still
// refers to the page, and filters the list to one type:
//   *[…][0]{"b": pageBuilder[_type == "cta"]{…members for cta…}}.b
// Blocks nested in containers (a branch holding another `_type == …` list) get queries that walk the same
// path. Stitching matches blocks by position within their type, in document order; each list also gets an
// "other" query for types without a branch of their own.
import type {
  FunctionDeclaration,
  KeyedMember,
  Node,
  ObjectLiteral,
  ObjectMember,
  Pair,
  Program,
  Projection,
  StringLiteral,
} from "./ast.js";
import {
  budget,
  encodedQueryLength,
  GET_QUERY_LIMIT,
  type BudgetEntry,
  type QueryParams,
} from "./budget.js";
import { compile, type CompileOptions, type CompileResult } from "./compile.js";
import { GroqTreeBuilder, implicitKey, traversalChain } from "./groq-tree.js";
import { minify } from "./minify.js";
import { parse } from "./parser.js";
import { print } from "./printer.js";
import { walk } from "./walk.js";

export class SplitError extends Error {
  override name = "SplitError";
}

/** The fetched results do not line up, e.g. content changed between the outline and a block query. */
export class StitchError extends Error {
  override name = "StitchError";
}

export interface SplitOptions {
  /** Key of the page projection member holding the blocks. Default: the list with the most type branches. */
  blocks?: string;
  /**
   * Block types whose branches hold nested block lists to split again. `"auto"` (default) splits a container
   * (a branch holding a list with its own `_type == …` branches, at any depth) only when its query would be
   * over the GET budget; a list of types always splits those; `"none"` keeps nested lists inline.
   */
  containers?: "auto" | "none" | readonly string[];
  /** Options for compiling each generated query. Default: compile's defaults. */
  compile?: CompileOptions;
  /** Query parameters used to measure the GET budget (for `containers: "auto"`). */
  params?: QueryParams;
}

/** A block list in the result: the keys from its parent object (page or block) to the array. */
export interface SitePlan {
  id: string;
  path: string[];
  /** Types with their own query; the others come from the site's `other` query. */
  types: string[];
  /** Nested block lists inside blocks of a container type. */
  containers: Record<string, SitePlan[]>;
}

export interface SplitQuery {
  id: string;
  site: string;
  /** Block type, or null for the site's "other" query. */
  type: string | null;
  /** Compiled query. */
  query: string;
  /** The generated query before compilation. */
  source: string;
  compile: CompileResult;
}

export interface SplitPlan {
  outline: string;
  root: SitePlan;
  /** Query text by id (`<site>#<type>` and `<site>#*`). */
  queries: Record<string, string>;
}

export interface SplitResult extends SplitPlan {
  outlineCompile: CompileResult;
  details: SplitQuery[];
}

const OTHER = "*";
const TYPE = "_type";

type Tri = boolean | undefined;

const not = (value: Tri): Tri => (value === undefined ? undefined : !value);
const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a && b);
const or = (a: Tri, b: Tri): Tri =>
  a === true || b === true ? true : a === false && b === false ? false : undefined;

const isTypeField = (node: Node): boolean => node.type === "Identifier" && node.name === TYPE;

// groq-js `match` (shared/matching.ts).
const CHARS = /([^!@#$%^&*(),\\/?";:{}|[\]+<>\s-])+/g;
const CHARS_WITH_WILDCARD = /([^!@#$%^&(),\\/?";:{}|[\]+<>\s-])+/g;
const EDGE_CHARS = /(\b\.+|\.+\b)/g;

function groqMatch(text: string, pattern: string): boolean {
  const tokens = text.replace(EDGE_CHARS, "").match(CHARS) ?? [];
  const terms = pattern.replace(EDGE_CHARS, "").match(CHARS_WITH_WILDCARD) ?? [];
  if (tokens.length === 0 || terms.length === 0) return false;
  return terms.every((term) => {
    const re = new RegExp(`^${term.slice(0, 1024).replace(/\*/g, ".*")}$`, "i");
    return tokens.some((token) => re.test(token));
  });
}

/** Literal string values of an array literal, or undefined. */
function stringList(node: Node): string[] | undefined {
  if (node.type !== "Array") return undefined;
  const values: string[] = [];
  for (const element of node.elements) {
    if (element.splat || element.value.type !== "String") return undefined;
    values.push(element.value.value);
  }
  return values;
}

/**
 * Evaluates a condition on a block whose `_type` is `type` (null: a type outside `known`). Undefined when it
 * depends on anything else.
 */
function typeCondition(node: Node, type: string | null, known: ReadonlySet<string>): Tri {
  switch (node.type) {
    case "Group":
      return typeCondition(node.expr, type, known);
    case "Prefix":
      return node.op === "!" ? not(typeCondition(node.expr, type, known)) : undefined;
    case "Binary": {
      if (node.op === "&&")
        return and(typeCondition(node.left, type, known), typeCondition(node.right, type, known));
      if (node.op === "||")
        return or(typeCondition(node.left, type, known), typeCondition(node.right, type, known));
      if (node.op === "==" || node.op === "!=") {
        const literal = isTypeField(node.left)
          ? node.right
          : isTypeField(node.right)
            ? node.left
            : undefined;
        if (literal?.type !== "String") return undefined;
        const equal: Tri =
          type === null ? (known.has(literal.value) ? false : undefined) : type === literal.value;
        return node.op === "==" ? equal : not(equal);
      }
      if (node.op === "match" && isTypeField(node.left) && node.right.type === "String") {
        return type === null ? undefined : groqMatch(type, node.right.value);
      }
      if (node.op === "in" && isTypeField(node.left)) {
        const values = stringList(node.right);
        if (!values) return undefined;
        if (type !== null) return values.includes(type);
        return values.every((v) => known.has(v)) ? false : undefined;
      }
      return undefined;
    }
    case "Call":
      return node.name === "defined" && node.args.length === 1 && isTypeField(node.args[0] as Node)
        ? type !== null
          ? true
          : undefined
        : undefined;
    default:
      return undefined;
  }
}

/** Every literal a condition compares `_type` with. */
function typeLiterals(node: Node, out: Set<string>): void {
  walk(node, (n) => {
    if (n.type !== "Binary") return;
    if ((n.op === "==" || n.op === "!=") && (isTypeField(n.left) || isTypeField(n.right))) {
      const literal = isTypeField(n.left) ? n.right : n.left;
      if (literal.type === "String") out.add(literal.value);
    }
    if (n.op === "in" && isTypeField(n.left)) for (const v of stringList(n.right) ?? []) out.add(v);
  });
}

const conditional = (member: ObjectMember): Pair | undefined =>
  member.type === "Expression" && member.value.type === "Pair" ? member.value : undefined;

/** Types named by the branches of a block list, nested branch objects included. */
function branchTypes(object: ObjectLiteral): Set<string> {
  const types = new Set<string>();
  const visit = (o: ObjectLiteral) => {
    for (const member of o.members) {
      const pair = conditional(member);
      if (!pair) continue;
      typeLiterals(pair.left, types);
      if (pair.right.type === "Object") visit(pair.right);
    }
  };
  visit(object);
  return types;
}

/** Whether an object has a conditional member comparing `_type` with a literal. */
function hasTypeBranches(object: ObjectLiteral): boolean {
  return object.members.some((member) => {
    const pair = conditional(member);
    if (!pair) return false;
    const literals = new Set<string>();
    typeLiterals(pair.left, literals);
    return literals.size > 0;
  });
}

/** The members a block of `type` evaluates; branches false for it are dropped, nested branch objects too. */
function membersFor(
  object: ObjectLiteral,
  type: string | null,
  known: ReadonlySet<string>,
): ObjectLiteral {
  const members: ObjectMember[] = [];
  for (const member of object.members) {
    const pair = conditional(member);
    if (!pair) {
      members.push(member);
      continue;
    }
    const holds = typeCondition(pair.left, type, known);
    if (holds === false) continue;
    if (pair.right.type === "Object") {
      const right = membersFor(pair.right, type, known);
      members.push({ ...member, value: { ...pair, right } } as ObjectMember);
    } else {
      members.push(member);
    }
  }
  return { ...object, members, trailingComma: false };
}

/** A block list in the syntax tree: `list[]{…}` or `list[filter]{…}`. */
interface Site {
  projection: Projection;
  /** The list expression (`pageBuilder` in `pageBuilder[]{…}`). */
  list: Node;
  /** The existing filter, if the list is `list[filter]{…}`. */
  filter: Node | null;
  key: string;
}

function asSite(value: Node, key: string): Site | undefined {
  if (value.type !== "Projection") return undefined;
  const base = value.base;
  if (base.type === "ArrayPostfix")
    return { projection: value, list: base.base, filter: null, key };
  if (base.type === "Bracket")
    return { projection: value, list: base.base, filter: base.expr, key };
  return undefined;
}

/** The result key of a member: explicit, or derived as groq-js derives it. */
function memberKey(member: ObjectMember): string | undefined {
  if (member.type === "Keyed") return member.key.value;
  if (member.type !== "Expression" || member.value.type === "Pair") return undefined;
  try {
    return implicitKey(new GroqTreeBuilder().convert(member.value));
  } catch {
    return undefined;
  }
}

/** One step from an object to a nested object: the member key and its projection. */
interface Step {
  key: string;
  projection: Projection;
}

interface NestedSite {
  steps: Step[];
  site: Site;
}

/** Nested block lists inside the members a container type evaluates, with the path to each. */
function nestedSites(
  object: ObjectLiteral,
  type: string,
  known: ReadonlySet<string>,
): NestedSite[] {
  const found: NestedSite[] = [];
  const visit = (o: ObjectLiteral, steps: Step[], blockLevel: boolean) => {
    for (const member of o.members) {
      const pair = conditional(member);
      if (pair) {
        // Branch objects splat into the block itself; only branches certain for this type are followed.
        if (
          blockLevel &&
          pair.right.type === "Object" &&
          typeCondition(pair.left, type, known) === true
        ) {
          visit(pair.right, steps, true);
        }
        continue;
      }
      const key = memberKey(member);
      if (key === undefined || member.type === "Spread" || !member.value) continue;
      const site = asSite(member.value, key);
      if (site && hasTypeBranches(site.projection.object)) {
        found.push({ steps, site });
        continue;
      }
      if (member.value.type === "Projection") {
        visit(member.value.object, [...steps, { key, projection: member.value }], false);
      }
    }
  };
  visit(object, [], true);
  return found;
}

const at = (node: Node) => ({ start: node.start, end: node.start });

function stringLiteral(value: string, near: Node): StringLiteral {
  return { type: "String", raw: JSON.stringify(value), value, ...at(near) };
}

function keyed(key: string, value: Node): KeyedMember {
  return { type: "Keyed", key: stringLiteral(key, value), value, ...at(value) };
}

function identifier(name: string, near: Node): Node {
  return { type: "Identifier", name, ...at(near) };
}

function typeEquals(type: string, near: Node): Node {
  return {
    type: "Binary",
    op: "==",
    left: identifier(TYPE, near),
    right: stringLiteral(type, near),
    parens: false,
    ...at(near),
  };
}

function group(expr: Node): Node {
  return { type: "Group", expr, ...at(expr) };
}

/** `_type == "x"`, or for the other query `!(_type in [known…])`; combined with an existing filter. */
function typeFilter(site: Site, type: string | null, known: readonly string[]): Node {
  const near = site.projection;
  let condition: Node;
  if (type === null) {
    const list: Node = {
      type: "Array",
      elements: known.map((t) => ({ value: stringLiteral(t, near), splat: false, ...at(near) })),
      trailingComma: false,
      ...at(near),
    };
    const inList: Node = {
      type: "Binary",
      op: "in",
      left: identifier(TYPE, near),
      right: list,
      parens: false,
      ...at(near),
    };
    condition = { type: "Prefix", op: "!", expr: group(inList), ...at(near) };
  } else {
    condition = typeEquals(type, near);
  }
  if (!site.filter) return condition;
  return {
    type: "Binary",
    op: "&&",
    left: group(site.filter),
    right: condition,
    parens: false,
    ...at(near),
  };
}

/** `list[filter]{object}` */
function filtered(site: Site, filter: Node, object: ObjectLiteral): Projection {
  return {
    type: "Projection",
    base: { type: "Bracket", base: site.list, expr: filter, ...at(site.projection) },
    object,
    pipe: false,
    ...at(site.projection),
  };
}

function objectOf(members: ObjectMember[], near: Node): ObjectLiteral {
  return { type: "Object", members, trailingComma: false, ...at(near) };
}

/** `base{object}` for a step, keeping the step's own base (`tabs[]`, `tab->` …). */
function stepProjection(step: Step, members: ObjectMember[]): Projection {
  return { ...step.projection, object: objectOf(members, step.projection), pipe: false };
}

class Splitter {
  private readonly program: Program;
  private readonly page: Projection;
  private readonly root: Site;
  private readonly containers: SplitOptions["containers"];
  private readonly compileOptions: CompileOptions;
  private readonly params: QueryParams;
  private readonly queries: Array<{ id: string; site: string; type: string | null; body: Node }> =
    [];
  private readonly sites = new Map<
    SitePlan,
    { site: Site; known: string[]; nested: Map<string, NestedSite[]>; wrap: (inner: Node) => Node }
  >();

  constructor(query: string, options: SplitOptions) {
    this.program = parse(minify(query));
    const body = this.program.body;
    if (body.type !== "Projection" || body.pipe) {
      throw new SplitError("the page query must end with a projection: *[…][0]{…}");
    }
    this.page = body;
    this.checkSingleDocument();
    this.containers = options.containers ?? "auto";
    this.compileOptions = options.compile ?? {};
    this.params = options.params ?? {};
    this.root = this.findBlocks(options.blocks);
  }

  /** The page projection must apply to one document, not map over a list. */
  private checkSingleDocument(): void {
    const { base } = traversalChain(this.page);
    const tree = new GroqTreeBuilder(this.program.functions, {
      opaque: (node) => (node === this.page.object ? { type: "Opaque" } : undefined),
    }).convert(this.page);
    if (tree.type !== "Projection" || base.type === "Pipe") {
      throw new SplitError("the page query must select a single document (for example *[…][0]{…})");
    }
  }

  private findBlocks(key: string | undefined): Site {
    let best: { site: Site; branches: number } | undefined;
    for (const member of this.page.object.members) {
      const memberKeyName = memberKey(member);
      if (memberKeyName === undefined || member.type === "Spread" || !member.value) continue;
      const site = asSite(member.value, memberKeyName);
      if (!site) continue;
      if (key !== undefined) {
        if (memberKeyName === key) return site;
        continue;
      }
      const branches = branchTypes(site.projection.object).size;
      if (branches > 0 && (!best || branches > best.branches)) best = { site, branches };
    }
    if (key !== undefined) throw new SplitError(`the page projection has no block list "${key}"`);
    if (!best)
      throw new SplitError("no block list with _type branches found in the page projection");
    return best.site;
  }

  /** Encoded length of a generated query once compiled. */
  private encodedSize(body: Node): number {
    return encodedQueryLength(compile(this.text(body), this.compileOptions).query, this.params);
  }

  /**
   * The nested lists to split out of blocks of `type`: all of them for configured containers; with
   * `"auto"`, only when the block query is over budget, and only lists whose removal shrinks it by a tenth.
   */
  private containerSites(
    site: Site,
    type: string,
    known: string[],
    found: NestedSite[],
    wrap: (inner: Node) => Node,
  ): NestedSite[] {
    if (this.containers === "none") return [];
    if (Array.isArray(this.containers)) return this.containers.includes(type) ? found : [];
    const object = membersFor(site.projection.object, type, new Set(known));
    const query = (o: ObjectLiteral) => wrap(filtered(site, typeFilter(site, type, known), o));
    const inline = this.encodedSize(query(object));
    if (inline < GET_QUERY_LIMIT) return [];
    return found.filter((nested) => {
      const outline: Projection = {
        ...nested.site.projection,
        object: objectOf(
          [
            {
              type: "Expression",
              value: identifier("_key", site.projection),
              ...at(site.projection),
            },
            {
              type: "Expression",
              value: identifier(TYPE, site.projection),
              ...at(site.projection),
            },
          ],
          site.projection,
        ),
        pipe: false,
      };
      const without = this.encodedSize(
        query(replaceProjections(object, new Map([[nested.site.projection, outline]]))),
      );
      return inline - without >= inline / 10;
    });
  }

  /** Builds the site tree; `wrap` rebuilds the path from the page to the site's list. */
  private plan(
    site: Site,
    id: string,
    path: string[],
    depth: number,
    wrap: (inner: Node) => Node,
  ): SitePlan {
    const known = [...branchTypes(site.projection.object)];
    const knownSet = new Set(known);
    const plan: SitePlan = { id, path, types: known, containers: {} };
    const nested = new Map<string, NestedSite[]>();
    this.sites.set(plan, { site, known, nested, wrap });
    if (depth >= 6) return plan;
    for (const type of known) {
      const candidates = nestedSites(
        membersFor(site.projection.object, type, knownSet),
        type,
        knownSet,
      );
      const found =
        candidates.length === 0 ? [] : this.containerSites(site, type, known, candidates, wrap);
      if (found.length === 0) continue;
      nested.set(type, found);
      plan.containers[type] = found.map((n) => {
        const childPath = [...n.steps.map((s) => s.key), n.site.key];
        const childWrap = (inner: Node) => {
          const members = this.childMembers([n], [plan], () => inner);
          return wrap(
            filtered(site, typeFilter(site, type, known), objectOf(members, site.projection)),
          );
        };
        return this.plan(
          n.site,
          `${id}>${type}:${childPath.join(".")}`,
          childPath,
          depth + 1,
          childWrap,
        );
      });
    }
    return plan;
  }

  /** `list[]{_key, _type, …container children…}` with the site's own base. */
  private outlineValue(plan: SitePlan): Projection {
    const { site, nested } = this.sites.get(plan) as {
      site: Site;
      nested: Map<string, NestedSite[]>;
    };
    const near = site.projection;
    const members: ObjectMember[] = [
      { type: "Expression", value: identifier("_key", near), ...at(near) },
      { type: "Expression", value: identifier(TYPE, near), ...at(near) },
    ];
    for (const [type, sites] of nested) {
      const children = plan.containers[type] as SitePlan[];
      const branch = this.childMembers(sites, children, (child) => this.outlineValue(child));
      members.push({
        type: "Expression",
        value: {
          type: "Pair",
          left: typeEquals(type, near),
          right: objectOf(branch, near),
          ...at(near),
        },
        ...at(near),
      });
    }
    return { ...site.projection, object: objectOf(members, near), pipe: false };
  }

  /** Members that rebuild the paths to nested sites, merging shared steps. */
  private childMembers(
    sites: NestedSite[],
    plans: SitePlan[],
    leaf: (plan: SitePlan, site: NestedSite) => Node,
  ): ObjectMember[] {
    interface Trie {
      step?: Step;
      children: Map<string, Trie>;
      leaves: Array<{ key: string; value: Node }>;
    }
    const root: Trie = { children: new Map(), leaves: [] };
    sites.forEach((nested, i) => {
      let node = root;
      for (const step of nested.steps) {
        let child = node.children.get(step.key);
        if (!child) {
          child = { step, children: new Map(), leaves: [] };
          node.children.set(step.key, child);
        }
        node = child;
      }
      node.leaves.push({ key: nested.site.key, value: leaf(plans[i] as SitePlan, nested) });
    });
    const build = (node: Trie): ObjectMember[] => [
      ...[...node.children.entries()].map(([key, child]) =>
        keyed(key, stepProjection(child.step as Step, build(child))),
      ),
      ...node.leaves.map(({ key, value }) => keyed(key, value)),
    ];
    return build(root);
  }

  /** The members of a block of `type` at `plan`, with nested sites replaced by their outlines. */
  private blockObject(plan: SitePlan, type: string | null): ObjectLiteral {
    const { site, known } = this.sites.get(plan) as { site: Site; known: string[] };
    const object = membersFor(site.projection.object, type, new Set(known));
    const children = type === null ? undefined : plan.containers[type];
    if (!children) return object;
    const outlines = new Map<Projection, Projection>();
    for (const child of children) {
      const childSite = (this.sites.get(child) as { site: Site }).site;
      outlines.set(childSite.projection, this.outlineValue(child));
    }
    return replaceProjections(object, outlines);
  }

  /** Queries for a site and its descendants. */
  private generate(plan: SitePlan): void {
    const { site, known, wrap } = this.sites.get(plan) as {
      site: Site;
      known: string[];
      wrap: (inner: Node) => Node;
    };
    for (const type of [...known, null]) {
      const value = filtered(site, typeFilter(site, type, known), this.blockObject(plan, type));
      this.queries.push({
        id: `${plan.id}#${type ?? OTHER}`,
        site: plan.id,
        type,
        body: wrap(value),
      });
    }
    for (const children of Object.values(plan.containers))
      for (const child of children) this.generate(child);
  }

  run(): SplitResult {
    const compileOptions = this.compileOptions;
    const pageObject = this.page.object;
    const wrapPage = (inner: Node): Node => ({
      type: "Attribute",
      base: { ...this.page, object: objectOf([keyed("b", inner)], pageObject) },
      name: "b",
      ...at(this.page),
    });
    const root = this.plan(this.root, this.root.key, [this.root.key], 0, wrapPage);
    this.generate(root);
    const outlineProjection = this.outlineValue(root);
    const outlineObject: ObjectLiteral = {
      ...pageObject,
      members: pageObject.members.map((member) =>
        member.value === this.root.projection ? { ...member, value: outlineProjection } : member,
      ) as ObjectMember[],
    };
    const outlineSource = this.text({ ...this.page, object: outlineObject });
    const outlineCompile = compile(outlineSource, compileOptions);
    const details: SplitQuery[] = this.queries.map(({ id, site, type, body }) => {
      const source = this.text(body);
      const result = compile(source, compileOptions);
      return { id, site, type, source, query: result.query, compile: result };
    });
    return {
      outline: outlineCompile.query,
      root,
      queries: Object.fromEntries(details.map((d) => [d.id, d.query])),
      outlineCompile,
      details,
    };
  }

  /** Prints a query body with the existing declarations it reaches. */
  private text(body: Node): string {
    const byName = new Map(this.program.functions.map((fn) => [`${fn.namespace}::${fn.name}`, fn]));
    const reached = new Set<FunctionDeclaration>();
    const visit = (node: Node) =>
      walk(node, (n) => {
        if (n.type !== "Call" || n.namespace === null) return;
        const fn = byName.get(`${n.namespace}::${n.name}`);
        if (fn && !reached.has(fn)) {
          reached.add(fn);
          visit(fn.body);
        }
      });
    visit(body);
    const functions = this.program.functions.filter((fn) => reached.has(fn));
    return print({ functions, body, start: 0, end: 0 });
  }
}

/** Copies `object` with the given projections (anywhere inside it) replaced. */
function replaceProjections(
  object: ObjectLiteral,
  replacements: Map<Projection, Projection>,
): ObjectLiteral {
  const replaceNode = (node: Node): Node => {
    if (node.type === "Projection") {
      const replacement = replacements.get(node);
      if (replacement) return replacement;
      return { ...node, object: replaceProjections(node.object, replacements) };
    }
    if (node.type === "Pair" && node.right.type === "Object") {
      return { ...node, right: replaceProjections(node.right, replacements) };
    }
    if (node.type === "Object") return replaceProjections(node, replacements);
    return node;
  };
  return {
    ...object,
    members: object.members.map((member) =>
      member.value ? ({ ...member, value: replaceNode(member.value) } as ObjectMember) : member,
    ),
  };
}

/**
 * Splits a page query into an outline query and one query per block type (plus an "other" query per block
 * list), each compiled with `options.compile`.
 * @throws {SplitError} The query has no single-document page projection with a block list.
 */
export function split(query: string, options: SplitOptions = {}): SplitResult {
  return new Splitter(query, options).run();
}

/** Plain JSON plan for runtime use (no compile reports). */
export function toPlan({ outline, root, queries }: SplitPlan): SplitPlan {
  return { outline, root, queries };
}

// ---------------------------------------------------------------------------------------------- runtime

type JsonObject = Record<string, unknown>;

interface Position {
  array: unknown[];
  index: number;
  item: unknown;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The items of every block list found by following `path` from each object (arrays flatten). */
function itemsAt(objects: readonly unknown[], path: readonly string[]): Position[] {
  let values: unknown[] = [...objects];
  for (const key of path.slice(0, -1)) {
    const next: unknown[] = [];
    const descend = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(descend);
      else if (isObject(value) && value[key] !== undefined) next.push(value[key]);
    };
    values.forEach(descend);
    values = next.flatMap((v) => (Array.isArray(v) ? v : [v]));
  }
  const last = path.at(-1) as string;
  const positions: Position[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!isObject(value)) return;
    const array = value[last];
    if (Array.isArray(array))
      array.forEach((item, index) => positions.push({ array, index, item }));
  };
  values.forEach(collect);
  return positions;
}

const typeOf = (item: unknown): unknown => (isObject(item) ? item[TYPE] : undefined);

interface ChainLink {
  site: SitePlan;
  type: string;
}

function belongs(item: unknown, type: string, site: SitePlan): boolean {
  const itemType = typeOf(item);
  return type === OTHER ? !site.types.includes(itemType as string) : itemType === type;
}

/** Where blocks of `type` sit in the page, in document order. */
function positionsOf(
  page: unknown,
  chain: readonly ChainLink[],
  site: SitePlan,
  type: string,
): Position[] {
  let objects: unknown[] = [page];
  for (const link of chain) {
    objects = itemsAt(objects, link.site.path)
      .filter((p) => typeOf(p.item) === link.type)
      .map((p) => p.item);
  }
  return itemsAt(objects, site.path).filter((p) => belongs(p.item, type, site));
}

/** The blocks a site query returned, in document order. */
function blocksOf(result: unknown, chain: readonly ChainLink[], site: SitePlan): unknown[] {
  if (!Array.isArray(result)) return [];
  if (chain.length === 0) return result;
  let objects: unknown[] = result;
  for (const link of chain.slice(1)) objects = itemsAt(objects, link.site.path).map((p) => p.item);
  return itemsAt(objects, site.path).map((p) => p.item);
}

function walkSites(
  site: SitePlan,
  chain: ChainLink[],
  visit: (site: SitePlan, chain: ChainLink[]) => void,
): void {
  visit(site, chain);
  for (const [type, children] of Object.entries(site.containers)) {
    for (const child of children) walkSites(child, [...chain, { site, type }], visit);
  }
}

/** Ids of the block queries a page needs, given its outline result. */
export function neededQueries(plan: SplitPlan, outline: unknown): string[] {
  if (outline === null || outline === undefined) return [];
  const ids: string[] = [];
  walkSites(plan.root, [], (site, chain) => {
    // Types present at this site; nested sites only under the containers present.
    const items = positionsOf(outline, chain, site, OTHER).length;
    if (items > 0) ids.push(`${site.id}#${OTHER}`);
    for (const type of site.types) {
      if (positionsOf(outline, chain, site, type).length > 0) ids.push(`${site.id}#${type}`);
    }
  });
  return ids.filter((id) => id in plan.queries);
}

/**
 * Merges block query results into the outline result: the monolithic query's result.
 * @throws {StitchError} When a block query returns a different number of blocks than the outline shows.
 */
export function stitch(
  plan: SplitPlan,
  outline: unknown,
  results: Readonly<Record<string, unknown>>,
): unknown {
  if (outline === null || outline === undefined) return outline;
  const page = structuredClone(outline);
  walkSites(plan.root, [], (site, chain) => {
    for (const type of [...site.types, OTHER]) {
      const id = `${site.id}#${type}`;
      if (!(id in results)) continue;
      const positions = positionsOf(page, chain, site, type);
      const blocks = blocksOf(results[id], chain, site);
      if (positions.length !== blocks.length) {
        throw new StitchError(
          `${id}: the outline shows ${positions.length} blocks but the query returned ${blocks.length}`,
        );
      }
      positions.forEach((position, i) => {
        position.array[position.index] = blocks[i];
      });
    }
  });
  return page;
}

export type SplitFetcher = (query: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Fetches a split page: the outline, then the block queries it needs in parallel, stitched together.
 * When the results do not line up (content changed between requests), fetches `fallbackQuery` instead.
 */
export async function fetchSplit(
  plan: SplitPlan,
  fetcher: SplitFetcher,
  params: Record<string, unknown> = {},
  fallbackQuery?: string,
): Promise<unknown> {
  const outline = await fetcher(plan.outline, params);
  const ids = neededQueries(plan, outline);
  const values = await Promise.all(ids.map((id) => fetcher(plan.queries[id] as string, params)));
  try {
    return stitch(plan, outline, Object.fromEntries(ids.map((id, i) => [id, values[i]])));
  } catch (error) {
    if (error instanceof StitchError && fallbackQuery !== undefined)
      return fetcher(fallbackQuery, params);
    throw error;
  }
}

/** GET budget of the outline and every block query. */
export function splitBudget(plan: SplitPlan, params: QueryParams = {}): BudgetEntry[] {
  return budget([
    { name: "outline", query: plan.outline, params },
    ...Object.entries(plan.queries).map(([name, query]) => ({ name, query, params })),
  ]);
}
