/** Deterministic xorshift32 generator, so generated inputs are reproducible across runs and machines. */
export function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const TRIVIA = [" ", "\t", "\n", "\v", "\f", "\r", "\u0085", " ", "// generated\n"];

/**
 * Valid GROQ expressions wrapped in random trivia (groq-minifier's AST/result generator): arithmetic,
 * arrays, objects with Unicode keys and strings with escapes and comment-like text.
 */
export function generatedExpressions(count: number, seed = 0x47524f51): string[] {
  const next = xorshift(seed);
  const pick = <T>(items: readonly T[]): T => items[next() % items.length] as T;
  const wrap = (value: string) => `${pick(TRIVIA)}${value}${pick(TRIVIA)}`;
  const expression = (depth: number): string => {
    if (depth === 0 || next() % 3 === 0) return wrap(String(next() % 100));
    switch (next() % 5) {
      case 0:
        return (
          wrap("(") +
          expression(depth - 1) +
          wrap(pick(["+", "-", "*", "**"])) +
          expression(depth - 1) +
          wrap(")")
        );
      case 1:
        return wrap("[") + expression(depth - 1) + wrap(",") + expression(depth - 1) + wrap("]");
      case 2:
        return wrap('{"é👋":') + expression(depth - 1) + wrap("}");
      case 3:
        return wrap('"escaped \\" quote // URL https://example.invalid é👋"');
      default:
        return wrap("(") + expression(depth - 1) + wrap(")");
    }
  };
  return Array.from({ length: count }, () => expression(4));
}

// Lexically interesting fragments: every compound operator half, number parts, quotes, escapes, comments
// and the whitespace characters GROQ does and does not recognise. No unpaired surrogates.
const FRAGMENTS = [
  "a",
  "b",
  "_",
  "x",
  "e",
  "E",
  "u",
  "0",
  "1",
  "9",
  "+",
  "-",
  "*",
  "/",
  ".",
  "..",
  "=",
  ">",
  "<",
  "!",
  "&",
  "|",
  ":",
  "@",
  "^",
  "$",
  ",",
  ";",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  '"',
  "'",
  "\\",
  "\\u",
  "\\u{",
  "D83D",
  "DE00",
  "41",
  "ffff",
  "//",
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u0085",
  " ",
  " ",
  "　",
  "﻿",
  "é",
  "👋",
  "\0",
  "in",
  "match",
  "fn",
  "->",
  "=>",
  "**",
];

/** Random fragment soup: mostly invalid GROQ, which exercises scanner errors as much as boundaries. */
export function generatedSoup(count: number, seed: number, maxLength = 48): string[] {
  const next = xorshift(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let input = "";
    for (let length = next() % maxLength; length > 0; length--) {
      input += FRAGMENTS[next() % FRAGMENTS.length];
    }
    out.push(input);
  }
  return out;
}
