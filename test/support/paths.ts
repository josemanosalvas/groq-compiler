import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Reference checkout for differential tests; override with GROQ_MINIFIER_DIR. */
export const groqMinifierDir = resolve(
  process.env["GROQ_MINIFIER_DIR"] ?? join(repoRoot, "../groq-minifier"),
);
/** The private corpus is never stored in this repository; tests that need it skip without this variable. */
export const privateCorpus = process.env["GROQ_COMPILER_PRIVATE_CORPUS"];

/** `cargo` from PATH or rustup's default location, or undefined when Rust is not installed. */
export function findCargo(): string | undefined {
  const name = process.platform === "win32" ? "cargo.exe" : "cargo";
  const dirs = (process.env["PATH"] ?? "").split(delimiter);
  dirs.push(join(process.env["CARGO_HOME"] ?? join(homedir(), ".cargo"), "bin"));
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}
