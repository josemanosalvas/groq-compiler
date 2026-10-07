// Differential test against groq-minifier's Rust crate, the reference implementation of the minify contract.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { minify } from "../src/minify.js";
import { cases } from "./support/fixtures.js";
import { findCargo, groqMinifierDir } from "./support/paths.js";
import { generatedExpressions, generatedSoup } from "./support/random.js";

const INPUTS = 300_000;
const cargo = findCargo();
const crate = existsSync(join(groqMinifierDir, "examples/fixture_runner.rs"));
const skip = !cargo
  ? "cargo is not installed"
  : !crate
    ? `groq-minifier is not checked out at ${groqMinifierDir} (set GROQ_MINIFIER_DIR)`
    : undefined;

if (skip) {
  process.stdout.write(`Skipping the differential test against the Rust minifier: ${skip}.\n`);
}

function differentialInputs(): string[] {
  const inputs = [
    ...cases.valid.map((fixture) => fixture.input),
    ...cases.invalid.map((fixture) => fixture.input),
    ...generatedExpressions(2_000),
  ];
  for (const [left, right] of cases.pairs) {
    for (const separator of cases.separators) inputs.push(left + separator + right);
  }
  // Short soup hits token boundaries densely; long soup reaches deeper string and escape states.
  return inputs.concat(
    generatedSoup(200_000, 0x5eed, 24),
    generatedSoup(INPUTS - inputs.length - 200_000, 0xbeef, 96),
  );
}

type Outcome = { output: string } | { error: string };

describe.skipIf(skip !== undefined)("Rust reference minifier", () => {
  it(`agrees on ${INPUTS.toLocaleString("en")} generated inputs`, () => {
    const env = { ...process.env, PATH: `${dirname(cargo!)}:${process.env["PATH"] ?? ""}` };
    const build = spawnSync(
      cargo!,
      ["build", "--locked", "--release", "--quiet", "--example", "fixture_runner"],
      { cwd: groqMinifierDir, env, encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    const runner = join(groqMinifierDir, "target/release/examples/fixture_runner");
    const inputs = differentialInputs();
    expect(inputs).toHaveLength(INPUTS);
    const result = spawnSync(runner, {
      input: inputs.map((query) => JSON.stringify(query)).join("\n") + "\n",
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    expect(result.status, result.stderr).toBe(0);
    const native = result.stdout.trimEnd().split("\n");
    expect(native).toHaveLength(INPUTS);
    let mismatches = 0;
    let errors = 0;
    for (let i = 0; i < INPUTS; i++) {
      const query = inputs[i] as string;
      let actual: Outcome;
      try {
        actual = { output: minify(query) };
      } catch (error) {
        expect(error).toBeInstanceOf(SyntaxError);
        actual = { error: (error as Error).message };
        errors++;
      }
      const expected = JSON.parse(native[i] as string) as Outcome;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches++;
        if (mismatches <= 5) {
          expect.soft(actual, JSON.stringify(query)).toEqual(expected);
        }
      }
    }
    process.stdout.write(
      `Differential: ${INPUTS.toLocaleString("en")} inputs, ${errors.toLocaleString("en")} SyntaxErrors, ${mismatches} mismatches.\n`,
    );
    expect(mismatches).toBe(0);
    // Both outcomes must be well represented for the comparison to mean something.
    expect(errors).toBeGreaterThan(INPUTS / 10);
    expect(INPUTS - errors).toBeGreaterThan(INPUTS / 10);
  });
});
