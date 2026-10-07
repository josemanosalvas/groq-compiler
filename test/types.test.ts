// `groq-compiler/types`: TypeGen type deduplication and the assignability check that proves it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import {
  dedupeTypes,
  dedupeTypesSync,
  generateAssignabilityCheckSync,
  loadTypeScript,
  type DedupeOptions,
  type DedupeResult,
} from "../src/types.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const TSC7 = join(repoRoot, "node_modules/typescript-7/bin/tsc");
const fixture = readFileSync(
  new URL("fixtures/types/sanity.types.ts.txt", import.meta.url),
  "utf8",
);
/** Generated TypeGen fixture for the page-builder corpus. */
const corpusFile = fileURLToPath(
  new URL("../fixtures/page-builder/sanity.types.ts.txt", import.meta.url),
);
const corpus = existsSync(corpusFile) ? readFileSync(corpusFile, "utf8") : undefined;
const privateCorpus = process.env["GROQ_COMPILER_PRIVATE_CORPUS"];
/** Maximum output size for the optional private-corpus regression. */
const PRIVATE_BASELINE_BYTES = 1_089_802;

if (!privateCorpus) {
  process.stdout.write(
    "Skipping the private corpus type deduplication test: GROQ_COMPILER_PRIVATE_CORPUS is not set.\n",
  );
}
if (!corpus) {
  process.stdout.write(`Skipping the page-builder TypeGen test: ${corpusFile} does not exist.\n`);
}

const scratch = mkdtempSync(join(tmpdir(), "groq-compiler-types-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const dedupe = (source: string, options: Omit<DedupeOptions, "ts"> = {}): DedupeResult =>
  dedupeTypesSync(source, { ...options, ts });

/** Declarations of the new aliases (`type XShape = …;`), by name. */
function aliasBodies(output: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const match of output.matchAll(/^type (\w+) = (\{.*\}|\{\n[\s\S]*?\n\});$/gm)) {
    bodies.set(match[1] as string, match[2] as string);
  }
  return bodies;
}

function exportedNames(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest);
  return file.statements.flatMap((statement) =>
    "name" in statement &&
    statement.name &&
    ts.isIdentifier(statement.name as ts.Node) &&
    ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ? [(statement.name as ts.Identifier).text]
      : [],
  );
}

const COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  module: "preserve",
  target: "es2022",
  lib: ["es2022"],
  types: [],
  skipLibCheck: true,
};
let projects = 0;

/** Writes the check project for `before` → `after` into a scratch directory. */
function checkProject(before: string, after: string): { dir: string; types: readonly string[] } {
  const check = generateAssignabilityCheckSync(before, after, { ts });
  const dir = join(scratch, `check-${projects++}`);
  const files: Record<string, string> = {
    "before.ts": check.before,
    "after.ts": check.after,
    "check.ts": check.check,
    "tsconfig.json": JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files: ["check.ts"] }),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { dir, types: check.types };
}

/** Error count from the TypeScript 5.9 compiler API. */
function errorsWithTypeScript5(dir: string): string[] {
  const { options } = ts.convertCompilerOptionsFromJson(COMPILER_OPTIONS, dir);
  const program = ts.createProgram([join(dir, "check.ts")], options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Exit status and error count from the TypeScript 7 compiler. */
function errorsWithTypeScript7(dir: string): number {
  const run = spawnSync(process.execPath, [TSC7, "-p", dir], { encoding: "utf8" });
  const errors = `${run.stdout}${run.stderr}`.match(/error TS\d+/g)?.length ?? 0;
  return run.status === 0 ? errors : Math.max(errors, 1);
}

/** Fraction of aliases whose name and body survive when each candidate line is edited. */
function stability(source: string, edit: (line: string) => string | undefined): number[] {
  const base = aliasBodies(dedupe(source).output);
  const lines = source.split("\n");
  const fractions: number[] = [];
  lines.forEach((line, i) => {
    const edited = edit(line);
    if (edited === undefined) return;
    const copy = [...lines];
    copy[i] = edited;
    const after = aliasBodies(dedupe(copy.join("\n")).output);
    let kept = 0;
    for (const [name, body] of base) if (after.get(name) === body) kept++;
    fractions.push(kept / base.size);
  });
  return fractions.toSorted((a, b) => a - b);
}

const editQueryProperty = (start: number) => {
  let index = -1;
  return (line: string): string | undefined => {
    index++;
    if (index < start || !/^\s+\w+\??: string \| null;$/.test(line)) return undefined;
    return line.replace(": string", ": number");
  };
};

describe("dedupeTypes on a TypeGen-like fixture", () => {
  const result = dedupe(fixture);

  it("names repeated shapes and shrinks the file", () => {
    expect(result.aliases.map((alias) => alias.name)).toEqual([
      "SpanShape2",
      "BlockShape",
      "ImageShape",
      "PageQueryResultImageShape",
      "LinkShape",
      "PageBuilderBodyBlockShape",
      "OrderShape",
    ]);
    expect(result.reused).toEqual([{ name: "SanityImageCrop", uses: 2, size: expect.any(Number) }]);
    const image = result.aliases.find((alias) => alias.name === "PageQueryResultImageShape");
    expect(image?.uses).toBe(6);
    expect(result.stats.inputBytes).toBe(Buffer.byteLength(fixture));
    expect(result.stats.outputBytes).toBe(Buffer.byteLength(result.output));
    expect(result.stats.outputBytes).toBeLessThan(result.stats.inputBytes * 0.7);
  });

  it("keeps every exported type mutually assignable (TypeScript 5.9 and 7)", () => {
    const { dir, types } = checkProject(fixture, result.output);
    expect(types).toHaveLength(12);
    expect(errorsWithTypeScript5(dir)).toEqual([]);
    expect(errorsWithTypeScript7(dir)).toBe(0);
  });

  it("keeps exported names and their order; aliases are not exported", () => {
    expect(exportedNames(result.output)).toEqual(exportedNames(fixture));
    for (const alias of result.aliases) {
      expect(result.output).toContain(`\ntype ${alias.name} = {`);
      expect(result.output).not.toContain(`export type ${alias.name} `);
    }
  });

  it("declares aliases before the statement holding their first copy, at column 0", () => {
    const output = result.output;
    expect(output.indexOf("type OrderShape")).toBeLessThan(
      output.indexOf("// Variable: pagesQuery"),
    );
    expect(output.indexOf("type OrderShape")).toBeGreaterThan(output.indexOf("} | null;\n"));
    expect(aliasBodies(output).get("OrderShape")).toBe(
      "{\n  title: string | null;\n  summary: string | null;\n  position: number;\n  pinned: boolean;\n}",
    );
    // The first copy's comment stays with the alias body.
    expect(aliasBodies(output).get("ImageShape")).toContain('"hero.image.media"');
  });

  it("is deterministic and idempotent", () => {
    expect(dedupe(fixture).output).toBe(result.output);
    const again = dedupe(result.output);
    expect(again.output).toBe(result.output);
    expect(again.aliases).toEqual([]);
  });

  it("an edited property renames or changes only nearby aliases", () => {
    const start = fixture.split("\n").findIndex((line) => line.startsWith("// Variable:"));
    const fractions = stability(fixture, editQueryProperty(start));
    expect(fractions.length).toBeGreaterThan(10);
    // Median edit keeps most aliases; the worst still keeps more than half.
    expect(fractions[Math.floor(fractions.length / 2)]).toBeGreaterThanOrEqual(0.85);
    expect(fractions[0]).toBeGreaterThan(0.5);
  });
});

/** A multi-line object type literal at property depth 1. */
const shape = (body: string): string => `{\n    ${body.split("; ").join(";\n    ")};\n  }`;

describe("shapes", () => {
  // Shapes of at least 40 normalized characters repeated two or three times are worth an alias.
  const ABC = "alpha: string; beta: number; gamma: boolean; delta: string | null";

  it("treats different property order as a different shape", () => {
    const reordered = "beta: number; alpha: string; gamma: boolean; delta: string | null";
    const source = [
      `export type A = {\n  x: ${shape(ABC)};\n};`,
      `export type B = {\n  x: ${shape(reordered)};\n};`,
      `export type C = {\n  x: ${shape(ABC)};\n  y: ${shape(ABC)};\n};`,
    ].join("\n\n");
    const result = dedupe(source);
    expect(result.aliases).toEqual([{ name: "XShape", uses: 3, size: expect.any(Number) }]);
    expect(result.output).toContain("beta: number;\n    alpha: string;");
  });

  it("ignores formatting: whitespace, comments, separators, quotes, leading operators", () => {
    const source = [
      `export type A = { x: { alpha: string; beta: number; gamma: "a" | "b"; delta: string | null } };`,
      `export type B = {\n  x: {\n    "alpha": string, // note {\n    'beta': number,\n    gamma:\n      | 'a'\n      | "b";\n    /* } */ delta: string | null,\n  };\n};`,
      `export type C = { x: { alpha: string\n beta: number\n gamma: "a" | "b"\n delta: string | null } };`,
    ].join("\n\n");
    const result = dedupe(source);
    expect(result.aliases).toEqual([{ name: "XShape", uses: 3, size: expect.any(Number) }]);
    expect(result.output).toContain("export type B = {\n  x: XShape;\n};");
  });

  it("keeps readonly, optional and literal differences apart", () => {
    const variants = [
      ABC,
      "readonly alpha: string; beta: number; gamma: boolean; delta: string | null",
      "alpha?: string; beta: number; gamma: boolean; delta: string | null",
      'alpha: "string"; beta: number; gamma: boolean; delta: string | null',
    ];
    const source = variants
      .map((body, i) => `export type T${i} = {\n  x: ${shape(body)};\n  y: ${shape(body)};\n};`)
      .join("\n\n");
    const result = dedupe(source);
    expect(result.aliases.map((alias) => alias.uses)).toEqual([2, 2, 2, 2]);
    expect(new Set(aliasBodies(result.output).values()).size).toBe(4);
  });

  it("keeps string literals with braces, quotes and comment markers intact", () => {
    const body = `label: "a { b } \\"c\\" // d" | 'it\\'s } /* e */'; beta: number; gamma: boolean`;
    const source = [1, 2, 3].map((i) => `export type T${i} = { x: ${shape(body)} };`).join("\n");
    const result = dedupe(source);
    expect(result.aliases).toHaveLength(1);
    expect(aliasBodies(result.output).get("XShape")).toContain(
      `label: "a { b } \\"c\\" // d" | 'it\\'s } /* e */';`,
    );
    const { dir } = checkProject(source, result.output);
    expect(errorsWithTypeScript5(dir)).toEqual([]);
  });

  it("replaces copies inside nested arrays, unions and intersections", () => {
    const s = shape(ABC);
    const source = [
      `export type A = { x: Array<Array<${s}>> };`,
      `export type B = { x: (${s} & { extra: true }) | null };`,
      `export type C = { x: ${s}[] | ${s} };`,
    ].join("\n");
    const output = dedupe(source).output;
    expect(output).toContain("export type A = { x: Array<Array<XShape>> };");
    expect(output).toContain("export type B = { x: (XShape & { extra: true }) | null };");
    expect(output).toContain("export type C = { x: XShape[] | XShape };");
  });

  it("leaves literals that may use bound names in place", () => {
    const s = shape(ABC);
    const source = [
      `export type Generic<T> = { x: ${s}; y: ${s}; t: T };`,
      `export type Mapped = { [K in "a" | "b"]: ${s} };`,
      `export type Fn = { f: (value: string) => ${s}; g(): ${s} };`,
      `export interface WithThis { x: { self: this; alpha: string; beta: number; gamma: boolean } }`,
      `export interface WithThat { x: { self: this; alpha: string; beta: number; gamma: boolean } }`,
    ].join("\n");
    const result = dedupe(source);
    expect(result.aliases).toEqual([]);
    expect(result.output).toBe(source);
  });

  it("uses an existing type alias whose whole type is the shape", () => {
    const s = shape(ABC);
    const source = `export type Abc = ${s};\n\nexport type A = { x: ${s}; y: Array<${s}> };\n`;
    const result = dedupe(source);
    expect(result.output).toContain("export type A = { x: Abc; y: Array<Abc> };");
    expect(result.reused).toEqual([{ name: "Abc", uses: 2, size: expect.any(Number) }]);
    expect(result.aliases).toEqual([]);
    const separate = dedupe(source, { reuseDeclarations: false });
    expect(separate.output).toContain("export type A = { x: XShape; y: Array<XShape> };");
  });

  it("leaves small shapes inline unless minSize allows them", () => {
    const small = "{ id: string; n: number }";
    const source = [1, 2, 3, 4, 5, 6]
      .map((i) => `export type T${i} = { item: ${small} };`)
      .join("\n");
    expect(dedupe(source).aliases).toEqual([]);
    expect(dedupe(source, { minSize: 0 }).aliases).toEqual([
      { name: "ItemShape", uses: 6, size: small.length },
    ]);
  });

  it("names aliases from _type, then the property path, never reusing an identifier", () => {
    const hero = shape(`_type: "hero-banner"; ${ABC}`);
    const cover = (kind: string) => `{ kind: "${kind}"; image: ${shape(`${ABC}; extra: 1`)} }`;
    const source = [
      `export type HeroBannerShape = string;`,
      ...["Page", "Post", "Event"].map(
        (name) => `export type ${name} = { blocks: Array<${hero}>; image: ${shape(ABC)} };`,
      ),
      ...["Card", "Tile", "Banner"].map(
        (name) => `export type ${name} = { cover: ${cover(name)} };`,
      ),
    ].join("\n\n");
    const result = dedupe(source);
    // `image` shapes share a base: the first keeps it, the other is qualified by its parent property.
    expect(result.aliases.map((alias) => alias.name).toSorted()).toEqual([
      "CoverImageShape",
      "HeroBannerShape2",
      "ImageShape",
    ]);
  });

  it("puts aliases for the first statement after the file header", () => {
    const s = shape(ABC);
    const source = `/**\n * Header.\n */\n\n// Source: schema.json\nexport type A = { x: ${s}; y: ${s} };\n`;
    expect(dedupe(source).output).toMatch(
      /^\/\*\*\n \* Header\.\n \*\/\n\ntype XShape = \{[\s\S]*?\n\};\n\n\/\/ Source: schema\.json\nexport type A = \{ x: XShape; y: XShape \};\n$/,
    );
  });

  it("rejects invalid input", () => {
    expect(() => dedupe("export type A = {")).toThrow(SyntaxError);
    expect(() => dedupe("type A = { x: string };")).toThrow(/not a module/);
    expect(() => dedupe(42 as unknown as string)).toThrow(TypeError);
  });
});

describe("TypeScript loading", () => {
  it("loads typescript lazily when options.ts is omitted", async () => {
    const module = await loadTypeScript();
    expect(module.version).toBe(ts.version);
    const result = await dedupeTypes(fixture);
    expect(result.output).toBe(dedupe(fixture).output);
  });

  it("explains how to fix a TypeScript without the compiler API", async () => {
    const specifier = "typescript-7";
    const typescript7 = ((await import(specifier)) as { default: { version: string } }).default;
    await expect(dedupeTypes(fixture, { ts: typescript7 })).rejects.toThrow(
      /typescript module 7\.\d+\.\d+ has no createSourceFile[\s\S]*typescript 5\.9 or 6[\s\S]*options\.ts/,
    );
    expect(() => dedupeTypesSync(fixture, { ts: { version: "0" } })).toThrow(/compiler API/);
  });
});

describe("generateAssignabilityCheck", () => {
  const output = dedupe(fixture).output;

  it("strips augmentations and shares exported values with the original", () => {
    const check = generateAssignabilityCheckSync(fixture, output, { ts });
    for (const text of [check.before, check.after]) {
      expect(text).not.toContain("declare global");
      expect(text).not.toContain('declare module "@sanity/client"');
    }
    expect(check.before).toContain("export declare const internalGroqTypeReferenceTo");
    expect(check.after).toContain(
      'import { internalGroqTypeReferenceTo } from "./before.js";\nexport { internalGroqTypeReferenceTo };',
    );
    expect(check.check).toContain('import type * as Before from "./before.js";');
  });

  it("fails to type-check when a type changes", () => {
    const changed = output.replace("pinned: boolean;", "pinned: boolean | null;");
    const symbol = output.replace(
      '[internalGroqTypeReferenceTo]?: "sanity.imageAsset";',
      '[internalGroqTypeReferenceTo]?: "sanity.fileAsset";',
    );
    for (const after of [changed, symbol]) {
      const { dir } = checkProject(fixture, after);
      expect(errorsWithTypeScript5(dir).length).toBeGreaterThan(0);
      expect(errorsWithTypeScript7(dir)).toBeGreaterThan(0);
    }
  });

  it("rejects files that export different names", () => {
    const missing = output.replace("export type Page = {", "type Page = {");
    expect(() => generateAssignabilityCheckSync(fixture, missing, { ts })).toThrow(
      /Exported types differ at position 7: Page before, AllSanitySchemaTypes after/,
    );
  });
});

describe.skipIf(!corpus)(
  `page-builder TypeGen output${corpus ? "" : " (skipped: no fixture)"}`,
  () => {
    it("shrinks, stays mutually assignable (TypeScript 5.9 and 7) and keeps names stable", () => {
      const source = corpus as string;
      const result = dedupe(source);
      expect(result.stats.outputBytes).toBeLessThan(result.stats.inputBytes * 0.85);
      expect(exportedNames(result.output)).toEqual(exportedNames(source));
      const { dir } = checkProject(source, result.output);
      expect(errorsWithTypeScript5(dir)).toEqual([]);
      expect(errorsWithTypeScript7(dir)).toBe(0);
      const start = source.split("\n").findIndex((line) => line.startsWith("// Variable:"));
      const fractions = stability(source, editQueryProperty(start)).filter((_, i) => i % 8 === 0);
      expect(fractions[Math.floor(fractions.length / 2)]).toBe(1);
      expect(fractions[0]).toBeGreaterThan(0.75);
      // A second run finds little left to name and never grows the file.
      const again = dedupe(result.output);
      expect(again.stats.outputBytes).toBeLessThanOrEqual(result.stats.outputBytes);
    });
  },
);

describe.skipIf(!privateCorpus)(
  `private corpus${privateCorpus ? "" : " (skipped: set GROQ_COMPILER_PRIVATE_CORPUS)"}`,
  () => {
    it("meets the size baseline and stays mutually assignable (TypeScript 5.9 and 7)", () => {
      const source = readFileSync(privateCorpus as string, "utf8");
      const result = dedupe(source);
      const { inputBytes, outputBytes } = result.stats;
      // Aggregates only: the corpus and anything derived from it stay out of logs and the repository.
      process.stdout.write(
        `Private corpus: ${inputBytes} → ${outputBytes} bytes, ${result.aliases.length} aliases.\n`,
      );
      expect(outputBytes).toBeLessThanOrEqual(PRIVATE_BASELINE_BYTES);
      expect(exportedNames(result.output)).toEqual(exportedNames(source));
      const { dir } = checkProject(source, result.output);
      expect(errorsWithTypeScript5(dir).length).toBe(0);
      expect(errorsWithTypeScript7(dir)).toBe(0);
    });
  },
);
