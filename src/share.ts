// Share pass: turns repeated projections into custom GROQ functions.
//
// Candidates are projection sites `B{…}`, `B->{…}`, `B[]{…}` and `B[]->{…}`, grouped by hash-consing the
// projected object. A site becomes `f::a(B)` with the declaration `fn f::a($a)=$a{…};` (or `$a->{…}`,
// `$a[]{…}`, `$a[]->{…}`, the only bodies Sanity accepts). groq-js expands calls while parsing, so a rewrite
// is legal exactly when the traversal chain around the site keeps its groq-js tree; each site is checked on
// its chain with opaque leaves. Groups are chosen largest first, as long as they pay for their declaration.
import type {
  Call,
  FunctionDeclaration,
  Node,
  ObjectLiteral,
  ObjectMember,
  Program,
  Projection,
  StringLiteral,
  TraversalNode,
} from "./ast.js";
import { isTraversal } from "./ast.js";
import { costFunction, type CostModel } from "./cost.js";
import {
  GroqTreeBuilder,
  GroqTreeError,
  implicitKey,
  traversalChain,
  type GroqNode,
} from "./groq-tree.js";
import { joinTokens, utf8Length } from "./lexer.js";
import { TokenWriter } from "./printer.js";
import { forEachChild, walk } from "./walk.js";

export type ShareMode = "documented" | "with-params";

/** The body shape of a shared function: `$p{…}`, `$p->{…}`, `$p[]{…}` or `$p[]->{…}`. */
export type SiteForm = "projection" | "deref" | "array" | "array-deref";

/** Legality rules from findings, "GROQ traps". Each can be switched off in tests to prove it matters. */
export type ShareRule =
  | "traversal"
  | "pipe"
  | "parentheses"
  | "parent-scope"
  | "result-used-further"
  | "shorthand-key"
  | "parameter-name"
  | "declaration-order"
  | "existing-functions";

export interface ShareOptions {
  mode: ShareMode;
  /** Allow function bodies to call other custom functions. */
  nested: boolean;
  cost: CostModel;
  /** Rename every custom function, existing ones included, and their parameters to short names. */
  mangle: boolean;
  /** Testing only: switch off legality rules. */
  disabledRules?: readonly ShareRule[];
  /** Diagnostics: apply only the functions with these indices (in selection order). */
  only?: ReadonlySet<number>;
}

export interface SharedFunction {
  /** `namespace::name` as declared in the output. */
  name: string;
  /** Position in selection order, for `ShareOptions.only`. */
  index: number;
  form: SiteForm;
  /** Call sites in the output. */
  uses: number;
  /** UTF-8 size of the shared projection. */
  bytes: number;
  /** Estimated saving in the cost model's units. */
  estimate: number;
  /** The body reads query parameters (`$site` …). */
  usesParams: boolean;
  /** The body calls other custom functions. */
  callsFunctions: boolean;
}

export interface SkipSummary {
  candidates: number;
  bytes: number;
}

export interface ShareResult {
  functions: SharedFunction[];
  /** Candidate projections left inline, by reason. */
  skipped: Record<string, SkipSummary>;
  /** Declarations no call reaches, removed from the output. */
  removedFunctions: string[];
  /** Existing functions renamed by `mangle`: old name → new name. */
  renamedFunctions: Record<string, string>;
}

const FORM_PREFIX: Record<SiteForm, string[]> = {
  projection: [],
  deref: ["->"],
  array: ["[", "]"],
  "array-deref": ["[", "]", "->"],
};

/** Namespaces of groq-js's built-in functions; generated functions never use them. */
const BUILT_IN_NAMESPACES = new Set([
  "global",
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

const LEAF_TYPES = new Set([
  "Everything",
  "This",
  "Identifier",
  "Parameter",
  "Parent",
  "String",
  "Number",
]);

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Short identifiers in order: a … Z, aa, ab, … */
export function shortName(index: number): string {
  let name = "";
  let n = index;
  for (;;) {
    name = ALPHABET[n % 52] + name;
    n = Math.floor(n / 52) - 1;
    if (n < 0) return name;
  }
}

interface Site {
  projection: Projection;
  form: SiteForm;
  /** The call argument. */
  base: Node;
  /** Explicit key the call needs, when the site is a shorthand member. */
  key: string | null;
  member: ObjectMember | undefined;
  group: string;
  size: number;
  bytes: number;
}

interface Chosen {
  index: number;
  form: SiteForm;
  sites: Site[];
  size: number;
  bytes: number;
  estimate: number;
}

type Region = "free" | "body" | "removed";

const HAS_PARENT = 1;
const HAS_PARAMETER = 2;
const HAS_CUSTOM_CALL = 4;
const HAS_BOOST = 8;

/** Parents, object members, hash-consed structure ids and content flags for the nodes of a query. */
class Index {
  readonly parents = new Map<Node, Node>();
  readonly members = new Map<Node, ObjectMember>();
  readonly ids = new Map<Node, number>();
  readonly flags = new Map<Node, number>();
  readonly projections: Projection[] = [];
  private readonly interned = new Map<string, number>();

  constructor(private readonly customFunctions: ReadonlySet<string>) {}

  add(root: Node): void {
    this.visit(root);
  }

  has(node: Node, flag: number): boolean {
    return ((this.flags.get(node) ?? 0) & flag) !== 0;
  }

  private ownFlags(node: Node): number {
    switch (node.type) {
      case "Parent":
        return HAS_PARENT;
      case "Parameter":
        return HAS_PARAMETER;
      case "Call":
        return (
          (this.customFunctions.has(`${node.namespace ?? "global"}::${node.name}`)
            ? HAS_CUSTOM_CALL
            : 0) | (node.name === "boost" ? HAS_BOOST : 0)
        );
      default:
        return 0;
    }
  }

  private intern(signature: string): number {
    let id = this.interned.get(signature);
    if (id === undefined) {
      id = this.interned.size;
      this.interned.set(signature, id);
    }
    return id;
  }

  private visit(node: Node): number {
    if (node.type === "Projection") this.projections.push(node);
    const children: number[] = [];
    let flags = this.ownFlags(node);
    const child = (value: Node) => {
      this.parents.set(value, node);
      const id = this.visit(value);
      flags |= this.flags.get(value) ?? 0;
      return id;
    };
    if (node.type === "Object") {
      for (const member of node.members) {
        let part: string;
        if (member.type === "Keyed") {
          this.members.set(member.value, member);
          part = `K${member.key.raw}=${child(member.value)}`;
        } else if (member.type === "Expression") {
          this.members.set(member.value, member);
          part = `X${child(member.value)}`;
        } else if (member.value) {
          this.members.set(member.value, member);
          part = `S${child(member.value)}`;
        } else {
          part = "S";
        }
        children.push(this.intern(part));
      }
    } else {
      forEachChild(node, (value) => {
        children.push(child(value));
      });
    }
    const id = this.intern(`${node.type}|${scalars(node)}|${children.join(",")}`);
    this.ids.set(node, id);
    this.flags.set(node, flags);
    return id;
  }
}

/** The non-child fields that distinguish nodes of one type. */
function scalars(node: Node): string {
  switch (node.type) {
    case "Parent":
      return String(node.levels);
    case "Identifier":
    case "Parameter":
    case "Attribute":
      return node.name;
    case "String":
    case "Number":
      return node.raw;
    case "Binary":
      return `${node.op}${node.parens ? "()" : ""}`;
    case "InRange":
      return `${node.exclusive}${node.parens}`;
    case "Order":
      return node.direction;
    case "Call":
      return `${node.namespace ?? ""}::${node.name}${node.trailingComma ? "," : ""}`;
    case "Slice":
      return String(node.exclusive);
    case "Projection":
      return String(node.pipe);
    case "Deref":
      return node.attr ?? "";
    case "Array":
      return `${node.trailingComma}${node.elements.map((e) => (e.splat ? "s" : "v")).join("")}`;
    case "Object":
      return String(node.trailingComma);
    default:
      return "";
  }
}

const parameter = (name: string, at: Node): Node => ({
  type: "Parameter",
  name,
  start: at.start,
  end: at.start,
});

/** The body chain of a function: `$param` followed by the form's operators and the projection. */
function bodyChain(form: SiteForm, param: string, object: ObjectLiteral): Projection {
  let base: Node = parameter(param, object);
  const at = { start: object.start, end: object.start };
  if (form === "array" || form === "array-deref") base = { type: "ArrayPostfix", base, ...at };
  if (form === "deref" || form === "array-deref") base = { type: "Deref", base, attr: null, ...at };
  return { type: "Projection", base, object, pipe: false, start: object.start, end: object.end };
}

/** The call argument `B` for a site of the given form, or undefined when the projection lacks that form. */
function siteBase(projection: Projection, form: SiteForm): Node | undefined {
  const base = projection.base;
  switch (form) {
    case "projection":
      return base;
    case "deref":
      return base.type === "Deref" && base.attr === null ? base.base : undefined;
    case "array":
      return base.type === "ArrayPostfix" ? base.base : undefined;
    case "array-deref":
      return base.type === "Deref" && base.attr === null && base.base.type === "ArrayPostfix"
        ? base.base.base
        : undefined;
  }
}

/** Replaces the reference to `old` in `parent` (or in an object member) with `replacement`. */
function replaceChild(parent: Node, old: Node, replacement: Node): void {
  const record = parent as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === old) {
      record[key] = replacement;
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i] as Record<string, unknown> | Node;
        if (item === old) {
          value[i] = replacement;
          return;
        }
        if (item && typeof item === "object" && "value" in item && item.value === old) {
          item.value = replacement;
          return;
        }
      }
    }
  }
  throw new Error(`BUG: ${old.type} is not a child of ${parent.type}`);
}

function containsNode(root: Node, predicate: (node: Node) => boolean): boolean {
  let found = false;
  walk(root, (node) => {
    if (!found && predicate(node)) found = true;
  });
  return found;
}

export class SharePass {
  private readonly index: Index;
  private readonly cost: (text: string) => number;
  private readonly disabled: ReadonlySet<ShareRule>;
  private readonly existing: Set<string>;
  private readonly skipped: Record<string, SkipSummary> = {};
  private namespace = "f";
  private param = "a";

  constructor(
    private readonly program: Program,
    private readonly options: ShareOptions,
  ) {
    this.cost = costFunction(options.cost);
    this.disabled = new Set(options.disabledRules ?? []);
    this.existing = new Set(program.functions.map((fn) => `${fn.namespace}::${fn.name}`));
    this.index = new Index(this.existing);
  }

  run(): ShareResult {
    const { program } = this;
    this.index.add(program.body);
    if (this.disabled.has("existing-functions")) {
      for (const fn of program.functions) this.index.add(fn.body);
    }
    this.chooseNames();
    const sites = this.collectSites();
    let chosen = this.select(sites);
    if (this.options.only) chosen = chosen.filter((c) => this.options.only?.has(c.index));
    const generated = this.emit(chosen);
    const removedFunctions = this.removeUnused();
    const renamedFunctions = this.options.mangle ? this.mangle() : {};
    this.order();
    const functions = this.describe(chosen, generated);
    return { functions, skipped: this.skipped, removedFunctions, renamedFunctions };
  }

  private skip(reason: string, bytes: number): void {
    const entry = (this.skipped[reason] ??= { candidates: 0, bytes: 0 });
    entry.candidates++;
    entry.bytes += bytes;
  }

  /** Picks a namespace no existing function uses and a parameter name no query parameter uses. */
  private chooseNames(): void {
    const namespaces = new Set(this.program.functions.map((fn) => fn.namespace));
    const candidates = [..."fghijklmnopqrstuvwxyz"].map(String);
    this.namespace =
      candidates.find((ns) => !namespaces.has(ns) && !BUILT_IN_NAMESPACES.has(ns)) ?? "fn0";
    if (this.disabled.has("parameter-name")) return;
    const used = new Set<string>();
    for (const fn of this.program.functions) {
      for (const p of fn.params) used.add(p);
      walk(fn.body, (node) => node.type === "Parameter" && used.add(node.name));
    }
    walk(this.program.body, (node) => node.type === "Parameter" && used.add(node.name));
    for (let i = 0; ; i++) {
      const name = shortName(i);
      if (!used.has(name)) {
        this.param = name;
        return;
      }
    }
  }

  private printedSize(form: SiteForm, object: ObjectLiteral): { size: number; bytes: number } {
    const writer = new TokenWriter();
    writer.push(...FORM_PREFIX[form]);
    writer.object(object);
    const text = writer.toString();
    return { size: this.cost(text), bytes: utf8Length(text) };
  }

  private collectSites(): Site[] {
    const sites: Site[] = [];
    const sizes = new Map<string, { size: number; bytes: number }>();
    for (const projection of this.index.projections) {
      const object = projection.object;
      const objectId = this.index.ids.get(object) as number;
      const sizeOf = (form: SiteForm) => {
        const key = `${form}:${objectId}`;
        let size = sizes.get(key);
        if (!size) {
          size = this.printedSize(form, object);
          sizes.set(key, size);
        }
        return size;
      };
      const forms = (["array-deref", "array", "deref", "projection"] as const).filter(
        (form) => siteBase(projection, form) !== undefined,
      );
      const maximal = forms[0] as SiteForm;
      if (!this.disabled.has("parent-scope") && this.index.has(object, HAS_PARENT)) {
        this.skip("uses the parent scope ^ (rejected by Sanity)", sizeOf(maximal).bytes);
        continue;
      }
      if (this.options.mode === "documented" && this.index.has(object, HAS_PARAMETER)) {
        this.skip("uses query parameters (share: with-params)", sizeOf(maximal).bytes);
        continue;
      }
      if (!this.options.nested && this.index.has(object, HAS_CUSTOM_CALL)) {
        this.skip("calls a custom function (nested: true)", sizeOf(maximal).bytes);
        continue;
      }
      if (this.index.has(object, HAS_BOOST)) {
        this.skip("uses boost(), which only score() accepts", sizeOf(maximal).bytes);
        continue;
      }
      let form: SiteForm | undefined;
      let failure: ShareRule | undefined;
      for (const candidate of forms) {
        const reason = this.legality(projection, candidate);
        if (reason === undefined) {
          form = candidate;
          break;
        }
        failure ??= reason;
      }
      if (form === undefined && failure !== undefined && this.disabled.has(failure)) form = maximal;
      if (form === undefined) {
        const reasons: Record<string, string> = {
          traversal: "maps over an array traversal (*, x[filter], x[].y)",
          pipe: "applies to a pipe expression (| order(…))",
          "result-used-further": "result is traversed further (.x, [0] …)",
        };
        this.skip(reasons[failure as string] ?? "changes the groq-js tree", sizeOf(maximal).bytes);
        continue;
      }
      const top = this.chainTop(projection);
      const member = this.index.members.get(top);
      let key: string | null = null;
      if (member?.type === "Expression" && top.type !== "Pair") {
        key = this.implicitKeyOf(top) ?? null;
        if (key === null) {
          this.skip("no key can be derived for the call", sizeOf(form).bytes);
          continue;
        }
        if (this.disabled.has("shorthand-key")) key = null;
      }
      let base = siteBase(projection, form) as Node;
      if (this.disabled.has("parentheses") && base.type === "Group") base = base.expr;
      const { size, bytes } = sizeOf(form);
      sites.push({
        projection,
        form,
        base,
        key,
        member: key === null ? undefined : member,
        group: `${form}:${objectId}`,
        size,
        bytes,
      });
    }
    return sites;
  }

  private chainTop(node: Node): Node {
    let top = node;
    for (;;) {
      const parent = this.index.parents.get(top);
      if (!parent || !isTraversal(parent) || parent.base !== top) return top;
      top = parent;
    }
  }

  private implicitKeyOf(top: Node): string | undefined {
    const objects = new Set<Node>();
    if (isTraversal(top)) {
      for (const op of traversalChain(top).ops)
        if (op.type === "Projection") objects.add(op.object);
    }
    const builder = new GroqTreeBuilder([], {
      opaque: (node) => (objects.has(node) ? { type: "Opaque" } : undefined),
    });
    try {
      return implicitKey(builder.convert(top));
    } catch (error) {
      if (error instanceof GroqTreeError) return undefined;
      throw error;
    }
  }

  /**
   * Whether replacing the site with a call keeps the groq-js tree of its traversal chain; returns the
   * violated rule otherwise.
   */
  private legality(projection: Projection, form: SiteForm): ShareRule | undefined {
    const top = this.chainTop(projection);
    if (this.sameChainTree(projection, form, top)) return undefined;
    if (top !== projection && this.sameChainTree(projection, form, projection)) {
      return "result-used-further";
    }
    const { base } = traversalChain(projection);
    return base.type === "Pipe" ? "pipe" : "traversal";
  }

  private sameChainTree(projection: Projection, form: SiteForm, top: Node): boolean {
    const { base: chainBase, ops } = traversalChain(top as TraversalNode);
    const leaves = new Map<Node, number>();
    for (const op of ops) if (op.type === "Projection") leaves.set(op.object, leaves.size);
    if (!LEAF_TYPES.has(chainBase.type)) leaves.set(chainBase, leaves.size);
    const opaque = (node: Node): GroqNode | undefined => {
      const id = leaves.get(node);
      return id === undefined ? undefined : { type: "Opaque", id };
    };
    const name = "share";
    const declaration: FunctionDeclaration = {
      namespace: name,
      name,
      params: ["__p"],
      body: bodyChain(form, "__p", projection.object),
      start: 0,
      end: 0,
    };
    const call: Call = {
      type: "Call",
      namespace: name,
      name,
      args: [siteBase(projection, form) as Node],
      trailingComma: false,
      start: projection.start,
      end: projection.end,
    };
    // Rebuild the operators above the site on top of the call.
    let rewritten: Node = call;
    const above = ops.slice(ops.indexOf(projection as TraversalNode) + 1);
    for (const op of above) rewritten = { ...op, base: rewritten } as Node;
    try {
      const builder = new GroqTreeBuilder([declaration], { opaque });
      return JSON.stringify(builder.convert(top)) === JSON.stringify(builder.convert(rewritten));
    } catch (error) {
      if (error instanceof GroqTreeError) return false;
      throw error;
    }
  }

  private region(node: Node, removed: Set<Node>, kept: Set<Node>): Region {
    for (let current = this.index.parents.get(node); current;) {
      if (removed.has(current)) return "removed";
      if (kept.has(current)) return "body";
      current = this.index.parents.get(current);
    }
    return "free";
  }

  private chainBelow(projection: Projection): Node[] {
    const nodes: Node[] = [];
    for (let n: Node = projection.base; isTraversal(n); n = n.base) nodes.push(n);
    return nodes;
  }

  private select(sites: Site[]): Chosen[] {
    const groups = new Map<string, Site[]>();
    for (const site of sites) {
      const group = groups.get(site.group);
      if (group) group.push(site);
      else groups.set(site.group, [site]);
    }
    const ordered = [...groups.values()].toSorted(
      (a, b) => (b[0] as Site).size - (a[0] as Site).size,
    );
    const removed = new Set<Node>();
    const kept = new Set<Node>();
    const chosenProjections = new Set<Node>();
    const locked = new Set<Node>();
    const chosen: Chosen[] = [];
    for (const group of ordered) {
      const first = group[0] as Site;
      if (group.length < 2) continue;
      const live = group.filter((site) => {
        const where = this.region(site.projection, removed, kept);
        if (where === "removed" || (where === "body" && !this.options.nested)) return false;
        if (locked.has(site.projection)) return false;
        return !this.chainBelow(site.projection).some((n) => chosenProjections.has(n));
      });
      if (live.length < 2) {
        this.skip("repeats vanish inside a shared fragment", first.bytes);
        continue;
      }
      const name = `${this.namespace}::${shortName(chosen.length)}`;
      const declaration = this.cost(`fn ${name}($${this.param})=$${this.param};`) + first.size;
      const call = this.cost(`${name}()`);
      let calls = 0;
      for (const site of live) calls += call + (site.key ? this.cost(`"${site.key}":`) : 0);
      const estimate = live.length * first.size - declaration - calls;
      if (estimate <= 0) {
        this.skip("too few repeats to pay for a declaration", first.bytes);
        continue;
      }
      const [keep, ...rest] = live as [Site, ...Site[]];
      kept.add(keep.projection.object);
      for (const site of rest) removed.add(site.projection.object);
      for (const site of live) {
        chosenProjections.add(site.projection);
        for (const n of this.chainBelow(site.projection)) locked.add(n);
      }
      chosen.push({
        index: chosen.length,
        form: first.form,
        sites: live,
        size: first.size,
        bytes: first.bytes,
        estimate,
      });
    }
    return chosen;
  }

  /** Rewrites the chosen sites into calls and adds their declarations; returns them in selection order. */
  private emit(chosen: Chosen[]): FunctionDeclaration[] {
    const declarations: FunctionDeclaration[] = [];
    chosen.forEach((fn, i) => {
      const name = shortName(i);
      for (const site of fn.sites) {
        const { projection } = site;
        const call: Call = {
          type: "Call",
          namespace: this.namespace,
          name,
          args: [site.base],
          trailingComma: false,
          start: projection.start,
          end: projection.end,
        };
        const parent = this.index.parents.get(projection);
        if (parent) replaceChild(parent, projection, call);
        else if (this.program.body === projection) this.program.body = call;
        else {
          const owner = this.program.functions.find((f) => f.body === projection);
          if (owner) owner.body = call;
        }
        if (site.member && site.key !== null && site.member.type === "Expression") {
          const key: StringLiteral = {
            type: "String",
            raw: `"${site.key}"`,
            value: site.key,
            start: site.member.start,
            end: site.member.start,
          };
          Object.assign(site.member, { type: "Keyed", key });
        }
      }
      const object = (fn.sites[0] as Site).projection.object;
      declarations.push({
        namespace: this.namespace,
        name,
        params: [this.param],
        body: bodyChain(fn.form, this.param, object),
        start: object.start,
        end: object.end,
      });
    });
    this.program.functions.push(...declarations);
    return declarations;
  }

  private calls(root: Node): string[] {
    const names: string[] = [];
    walk(root, (node) => {
      if (node.type === "Call" && node.namespace !== null)
        names.push(`${node.namespace}::${node.name}`);
    });
    return names;
  }

  /** Removes declarations that no call reaches from the query body. */
  private removeUnused(): string[] {
    const declared = new Map(
      this.program.functions.map((fn) => [`${fn.namespace}::${fn.name}`, fn]),
    );
    const reached = new Set<string>();
    const pending = this.calls(this.program.body);
    while (pending.length > 0) {
      const name = pending.pop() as string;
      const fn = declared.get(name);
      if (!fn || reached.has(name)) continue;
      reached.add(name);
      pending.push(...this.calls(fn.body));
    }
    const removed = [...declared.keys()].filter((name) => !reached.has(name));
    this.program.functions = this.program.functions.filter((fn) =>
      reached.has(`${fn.namespace}::${fn.name}`),
    );
    return removed;
  }

  /** Renames every function to `f::<short>` by descending call count, and parameters to the fresh name. */
  private mangle(): Record<string, string> {
    const counts = new Map<string, number>();
    const roots = [this.program.body, ...this.program.functions.map((fn) => fn.body)];
    for (const root of roots) {
      for (const name of this.calls(root)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const functions = this.program.functions.map((fn, order) => ({
      fn,
      order,
      old: `${fn.namespace}::${fn.name}`,
    }));
    functions.sort(
      (a, b) => (counts.get(b.old) ?? 0) - (counts.get(a.old) ?? 0) || a.order - b.order,
    );
    const renames = new Map<string, string>();
    functions.forEach(({ old }, i) => renames.set(old, shortName(i)));
    const namespace = "f";
    for (const root of roots) {
      walk(root, (node) => {
        if (node.type !== "Call" || node.namespace === null) return;
        const name = renames.get(`${node.namespace}::${node.name}`);
        if (name === undefined) return;
        node.namespace = namespace;
        node.name = name;
      });
    }
    const renamed: Record<string, string> = {};
    for (const { fn, old } of functions) {
      const oldParam = fn.params[0];
      if (oldParam !== undefined && oldParam !== this.param) {
        walk(fn.body, (node) => {
          if (node.type === "Parameter" && node.name === oldParam) node.name = this.param;
        });
        fn.params = [this.param];
      }
      fn.namespace = namespace;
      fn.name = renames.get(old) as string;
      if (this.existing.has(old)) renamed[old] = `${namespace}::${fn.name}`;
    }
    this.namespace = namespace;
    return renamed;
  }

  /** Declares callees before callers, keeping the original order otherwise. */
  private order(): void {
    const functions = this.program.functions;
    const byName = new Map(functions.map((fn) => [`${fn.namespace}::${fn.name}`, fn]));
    const ordered: FunctionDeclaration[] = [];
    const state = new Map<FunctionDeclaration, "visiting" | "done">();
    const visit = (fn: FunctionDeclaration) => {
      if (state.get(fn)) return;
      state.set(fn, "visiting");
      for (const name of this.calls(fn.body)) {
        const callee = byName.get(name);
        if (callee && callee !== fn) visit(callee);
      }
      state.set(fn, "done");
      ordered.push(fn);
    };
    for (const fn of functions) visit(fn);
    this.program.functions = this.disabled.has("declaration-order")
      ? ordered.toReversed()
      : ordered;
  }

  private describe(chosen: Chosen[], generated: FunctionDeclaration[]): SharedFunction[] {
    const live = new Set(this.program.functions);
    const declared = new Set(this.program.functions.map((fn) => `${fn.namespace}::${fn.name}`));
    const counts = new Map<string, number>();
    for (const root of [this.program.body, ...this.program.functions.map((fn) => fn.body)]) {
      for (const name of this.calls(root)) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const result: SharedFunction[] = [];
    chosen.forEach((fn, i) => {
      const declaration = generated[i] as FunctionDeclaration;
      if (!live.has(declaration)) return;
      const name = `${declaration.namespace}::${declaration.name}`;
      const body = declaration.body;
      result.push({
        name,
        index: fn.index,
        form: fn.form,
        uses: counts.get(name) ?? 0,
        bytes: fn.bytes,
        estimate: fn.estimate,
        usesParams: containsNode(body, (n) => n.type === "Parameter" && n.name !== this.param),
        callsFunctions: this.calls(body).some((callee) => declared.has(callee)),
      });
    });
    return result;
  }
}

/** Applies the share pass in place. */
export function share(program: Program, options: ShareOptions): ShareResult {
  return new SharePass(program, options).run();
}

/** Text of the generated declarations, for reports. */
export function declarationText(fn: FunctionDeclaration): string {
  const writer = new TokenWriter();
  writer.declaration(fn);
  return joinTokens(writer.tokens);
}
