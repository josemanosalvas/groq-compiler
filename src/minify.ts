import { assertQuery, needsSeparator, Scanner } from "./lexer.js";

/**
 * Removes comments and redundant whitespace, preserving the spelling of every token. Same contract as
 * groq-minifier: output never grows in UTF-8 bytes and is idempotent; empty, whitespace-only and
 * comment-only input returns an empty string.
 * @throws {TypeError} Non-string input or unpaired UTF-16 surrogates (even inside comments).
 * @throws {SyntaxError} Unterminated strings and invalid escapes, with a zero-based UTF-8 byte offset.
 */
export function minify(query: string): string {
  assertQuery(query);
  const scanner = new Scanner(query);
  let out = "";
  // Text from `pending` up to the current trivia is copied verbatim once trivia interrupts it.
  let pending = 0;
  let leftStart = -1;
  let leftEnd = -1;
  while (scanner.next()) {
    const { start, end } = scanner;
    if (scanner.triviaStart !== start) {
      out += query.slice(pending, scanner.triviaStart);
      if (
        leftStart >= 0 &&
        needsSeparator(query, leftStart, leftEnd, query, start, end, query.charCodeAt(end))
      ) {
        out += " ";
      }
      pending = start;
    }
    leftStart = start;
    leftEnd = end;
  }
  return out + query.slice(pending, scanner.triviaStart);
}
