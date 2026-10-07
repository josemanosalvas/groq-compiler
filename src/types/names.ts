// Alias names. Each alias is `<Base>Shape`: Base is the PascalCase `_type` value of the shape, or else the
// nearest property name of its first copy. When several aliases share a base, the one whose first copy
// comes first keeps `<Base>Shape` and each other one is prefixed with the shortest run of enclosing property
// names (outermost first) that tells it apart from the rest. A shape added or removed by an edit therefore
// renames only aliases with the same base and an overlapping path, instead of renumbering every later one.

const SUFFIX = "Shape";

/** One step of the property path to a type literal, innermost first; the root is the declaration. */
export interface PathSegment {
  readonly name: string;
  readonly parent: PathSegment | undefined;
}

export interface NameRequest {
  /** Value of the shape's `_type: "…"` property. */
  readonly typeName: string | undefined;
  /** Path to the alias's first copy. */
  readonly path: PathSegment;
  /** Offset of the first copy. */
  readonly start: number;
}

interface Candidate {
  readonly index: number;
  readonly base: string;
  /** Enclosing names that may prefix the base, innermost first. */
  readonly qualifiers: readonly string[];
  readonly start: number;
  name: string;
}

/** The base an alias name will start from (used to estimate name lengths before naming). */
export function baseName(request: Pick<NameRequest, "typeName" | "path">): string {
  return pascal(request.typeName ?? request.path.name) || "Object";
}

/**
 * Names for `requests`, in the same order. Names never equal a member of `taken` (every identifier in the
 * file), which receives the new names.
 */
export function assignNames(requests: readonly NameRequest[], taken: Set<string>): string[] {
  const groups = new Map<string, Candidate[]>();
  requests.forEach((request, index) => {
    const base = baseName(request);
    const qualifiers: string[] = [];
    let previous = base;
    let segment = request.typeName === undefined ? request.path.parent : request.path;
    for (; segment; segment = segment.parent) {
      const qualifier = pascal(segment.name);
      if (qualifier && qualifier !== previous) qualifiers.push(qualifier);
      if (qualifier) previous = qualifier;
    }
    const candidate = { index, base, qualifiers, start: request.start, name: "" };
    const group = groups.get(base);
    if (group) group.push(candidate);
    else groups.set(base, [candidate]);
  });

  const names: string[] = Array.from({ length: requests.length }, () => "");
  for (const base of [...groups.keys()].toSorted()) {
    const group = (groups.get(base) as Candidate[]).toSorted((a, b) => a.start - b.start);
    group.forEach((candidate, i) => {
      candidate.name = i === 0 ? qualified(candidate, 0) : distinct(candidate, group);
    });
    for (const candidate of group) {
      let name = /^[0-9]/.test(candidate.name) ? `_${candidate.name}` : candidate.name;
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}${n}`)) n++;
        name = `${name}${n}`;
      }
      taken.add(name);
      names[candidate.index] = name;
    }
  }
  return names;
}

/** The name with the fewest qualifiers (at least one) that no other member of the group has at that depth. */
function distinct(candidate: Candidate, group: readonly Candidate[]): string {
  const max = candidate.qualifiers.length;
  for (let depth = 1; depth < max; depth++) {
    const name = qualified(candidate, depth);
    if (!group.some((other) => other !== candidate && qualified(other, depth) === name))
      return name;
  }
  return qualified(candidate, max);
}

function qualified(candidate: Candidate, depth: number): string {
  const prefix = candidate.qualifiers.slice(0, depth).toReversed().join("");
  return `${prefix}${candidate.base}${SUFFIX}`;
}

/** PascalCase of the ASCII letters and digits in `text`; all-capital words are capitalized (`PAGE` → `Page`). */
function pascal(text: string): string {
  let out = "";
  for (const part of text.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    const word = part.length > 1 && part === part.toUpperCase() ? part.toLowerCase() : part;
    out += word.charAt(0).toUpperCase() + word.slice(1);
  }
  return out;
}
