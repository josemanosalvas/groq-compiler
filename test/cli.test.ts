import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { main, UsageError } from "../src/cli.js";
import { fixtureUrl } from "./support/fixtures.js";

async function run(args: string[], stdin?: string): Promise<{ out: string; err: string }> {
  let out = "";
  let err = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const writeErr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    if (stdin !== undefined) {
      const { writeFileSync, mkdtempSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const file = join(mkdtempSync(join(tmpdir(), "groq-compiler-")), "query.groq");
      writeFileSync(file, stdin);
      args = [...args, file];
    }
    await main(args);
  } finally {
    write.mockRestore();
    writeErr.mockRestore();
  }
  return { out, err };
}

describe("cli", () => {
  it("compiles a query file", async () => {
    const { out } = await run(["compile"], '* [ _type == "a" ] { "b": b, }');
    expect(out).toBe('*[_type=="a"]{b}\n');
  });

  it("reports the budget of a TypeGen file", async () => {
    const types = fileURLToPath(fixtureUrl("page-builder/sanity.types.ts.txt"));
    const { out } = await run(["budget", types, "--share", "with-params", "--nested"]);
    expect(out).toContain("All 8 compiled queries are sent as GET.");
    const json = JSON.parse((await run(["budget", types, "--json"])).out) as { name: string }[];
    expect(json.map((row) => row.name)).toContain("pageQuery");
  });

  it("splits a page query and reports each block query's budget", async () => {
    const { out } = await run(
      ["split", "--share", "with-params", "--nested"],
      '*[_type == "page"][0]{title, "blocks": blocks[]{..., _type == "a" => {x}, _type == "b" => {y}}}',
    );
    expect(out).toContain("outline and 3 block queries");
    expect(out).toContain("blocks#a");
    expect(out).toContain("All 4 queries fit the GET budget");
  });

  it("dedupes TypeGen types", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const out = join(mkdtempSync(join(tmpdir(), "groq-compiler-")), "sanity.types.ts");
    const input = new URL("fixtures/types/sanity.types.ts.txt", import.meta.url).pathname;
    const { err } = await run(["dedupe-types", input, "--out", out]);
    expect(err).toMatch(/aliases/);
    expect(readFileSync(out, "utf8").length).toBeLessThan(readFileSync(input, "utf8").length);
  });

  it("rejects unknown commands and options", async () => {
    await expect(main(["nope"])).rejects.toThrow(UsageError);
    await expect(main(["compile", "--share", "sometimes", "missing.groq"])).rejects.toThrow(
      UsageError,
    );
  });

  it.skipIf(!existsSync(new URL("../dist/cli.js", import.meta.url)))(
    "runs as an executable",
    () => {
      const out = execFileSync(process.execPath, ["dist/cli.js", "--help"], {
        encoding: "utf8",
      }).toString();
      expect(out).toContain("Usage: groq-compiler");
      expect(fixtureUrl("cases.json").pathname).toContain("fixtures");
    },
  );
});
