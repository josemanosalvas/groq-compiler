// Loads the TypeScript compiler API on demand. `typescript` is an optional peer dependency: importing
// `groq-compiler/types` must work without it, so nothing here imports it statically, and the public
// declarations do not mention its types.

/**
 * The `typescript` module (5.9 or 6), e.g. `import ts from "typescript"`. Typed loosely so these
 * declarations do not depend on an installed TypeScript; the module is validated when used.
 */
export interface TypeScriptModule {
  readonly version: string;
  readonly createSourceFile?: unknown;
}

const HELP =
  "groq-compiler/types needs the TypeScript compiler API from typescript 5.9 or 6. Install it " +
  "(npm install --save-dev typescript@^5.9) or pass the module as `options.ts`.";

/** Returns `module` when it has the compiler API; throws otherwise (TypeScript 7 has none). */
export function checkTypeScript(module: unknown): TypeScriptModule {
  const candidate = module as { createSourceFile?: unknown; version?: unknown } | null | undefined;
  if (typeof candidate?.createSourceFile !== "function") {
    const version = typeof candidate?.version === "string" ? ` ${candidate.version}` : "";
    throw new Error(
      `The loaded typescript module${version} has no createSourceFile, so it has no compiler API ` +
        `(TypeScript 7 ships without one). ${HELP}`,
    );
  }
  return candidate as TypeScriptModule;
}

/**
 * Imports `typescript` and checks that it has the compiler API.
 * @throws {Error} When `typescript` is not installed, or is a version without the compiler API (7).
 */
export async function loadTypeScript(): Promise<TypeScriptModule> {
  let module: unknown;
  try {
    module = await import("typescript");
  } catch (cause) {
    throw new Error(`Cannot import typescript. ${HELP}`, { cause });
  }
  // CommonJS builds (5.9, 6) expose the API on `default`; an ESM build would expose it directly.
  return checkTypeScript((module as { default?: unknown }).default ?? module);
}
