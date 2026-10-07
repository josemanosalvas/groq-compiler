// The compiler API as this package uses it internally. Kept apart from `load.ts` so the public declarations
// never import `typescript` types (consumers may not have TypeScript 5.9 or 6 installed).
import type * as TS from "typescript";
import { checkTypeScript, loadTypeScript, type TypeScriptModule } from "./load.js";

export type TypeScriptApi = typeof TS;

/** `module` typed as the compiler API, or an error explaining how to get one. */
export function asTypeScript(module: unknown): TypeScriptApi {
  return checkTypeScript(module) as unknown as TypeScriptApi;
}

/** `options.ts` when given, else the installed `typescript`. */
export async function resolveTypeScript(
  module: TypeScriptModule | undefined,
): Promise<TypeScriptApi> {
  return asTypeScript(module ?? (await loadTypeScript()));
}
