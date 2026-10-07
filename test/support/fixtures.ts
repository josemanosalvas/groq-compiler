import { readFileSync } from "node:fs";

export interface ValidCase {
  name: string;
  input: string;
  output: string;
  oracle: boolean;
  reason?: string;
}

export interface InvalidCase {
  name: string;
  input: string;
  kind: "unterminated" | "escape";
  offset: number;
  reason: string;
}

export interface Cases {
  separators: string[];
  pairs: [left: string, right: string, expected: string][];
  valid: ValidCase[];
  invalid: InvalidCase[];
}

export const fixtureUrl = (path: string): URL => new URL(`../../fixtures/${path}`, import.meta.url);

export const cases: Cases = JSON.parse(readFileSync(fixtureUrl("cases.json"), "utf8"));
