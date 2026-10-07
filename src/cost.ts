import { utf8Length } from "./lexer.js";

/** What the share pass minimises: UTF-8 bytes, or the length `@sanity/client` sends in a GET URL. */
export type CostModel = "bytes" | "url";

/**
 * Length of `text` once URLSearchParams-encoded: letters, digits, `*`, `-`, `.` and `_` stay one character,
 * a space becomes `+`, and every other UTF-8 byte becomes a three-character percent escape.
 */
export function urlEncodedLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 42 ||
      c === 45 ||
      c === 46 ||
      c === 95 ||
      c === 32
    ) {
      length += 1;
    } else if (c < 0x80) {
      length += 3;
    } else if (c < 0x800) {
      length += 6;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      length += 12;
      i++;
    } else {
      length += 9;
    }
  }
  return length;
}

export const costFunction = (model: CostModel): ((text: string) => number) =>
  model === "url" ? urlEncodedLength : (text) => utf8Length(text);
