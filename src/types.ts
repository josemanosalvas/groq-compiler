// `groq-compiler/types`: shrinks Sanity TypeGen output (`sanity.types.ts`) by naming repeated object types,
// and generates the check that proves the result means the same thing. Needs the TypeScript compiler API
// (typescript 5.9 or 6), loaded on first use unless passed as `options.ts`.
export {
  dedupeTypes,
  dedupeTypesSync,
  type DedupeAlias,
  type DedupeOptions,
  type DedupeResult,
} from "./types/dedupe.js";
export {
  generateAssignabilityCheck,
  generateAssignabilityCheckSync,
  type AssignabilityCheck,
  type AssignabilityCheckOptions,
} from "./types/check.js";
export { loadTypeScript, type TypeScriptModule } from "./types/load.js";
