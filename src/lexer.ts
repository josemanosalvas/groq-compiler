// Lexical rules shared by the minifier, the parser and the printer. Ported from groq-minifier's scanner:
// the same token boundaries, string validation and error messages.

const WORD = new Uint8Array(128);
for (let c = 48; c <= 57; c++) WORD[c] = 1;
for (let c = 65; c <= 90; c++) WORD[c] = 1;
for (let c = 97; c <= 122; c++) WORD[c] = 1;
WORD[95] = 1;

/** Letters, digits and underscore: the characters of identifiers and numbers. */
export const isWordCode = (c: number): boolean => c < 128 && WORD[c] === 1;
export const isDigitCode = (c: number): boolean => c >= 48 && c <= 57;
const isHex = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const hexValue = (c: number): number => (c <= 57 ? c - 48 : (c | 32) - 87);

/** GROQ whitespace: U+0009–U+000D, U+0020, U+0085 and U+00A0. */
export const isWhitespaceCode = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0x85 || c === 0xa0;

/** Whether two characters form one of GROQ's two-character operators when adjacent. */
function compound(l: number, r: number): boolean {
  switch (l) {
    case 42: // **
      return r === 42;
    case 61: // == =>
      return r === 61 || r === 62;
    case 33: // !=
    case 60: // <=
    case 62: // >=
      return r === 61;
    case 45: // ->
      return r === 62;
    case 38: // &&
      return r === 38;
    case 124: // ||
      return r === 124;
    case 58: // ::
      return r === 58;
    default:
      return false;
  }
}

/** UTF-8 length of `text`, which must be well-formed UTF-16. */
export function utf8Length(text: string, from = 0, to = text.length): number {
  let bytes = to - from;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) bytes += 1;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 2; // the surrogate pair counts as two code units, four bytes
      i++;
    } else bytes += 2;
  }
  return bytes;
}

/** Zero-based UTF-8 byte offset of the UTF-16 `index` in `query`. */
export const utf8Offset = (query: string, index: number): number => utf8Length(query, 0, index);

/** Throws groq-minifier's `TypeError`s for non-strings and unpaired UTF-16 surrogates. */
export function assertQuery(query: unknown): asserts query is string {
  if (typeof query !== "string") throw new TypeError("GROQ query must be a string");
  if (query.isWellFormed()) return;
  for (let i = 0; i < query.length; i++) {
    const unit = query.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = query.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError(`Unpaired UTF-16 surrogate at code unit offset ${i}`);
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`Unpaired UTF-16 surrogate at code unit offset ${i}`);
    }
  }
}

function invalidEscape(query: string, offset: number, reason: string): SyntaxError {
  return new SyntaxError(
    `invalid escape (${reason}) at UTF-8 byte offset ${utf8Offset(query, offset)}`,
  );
}

function hex4(query: string, pos: number, offset: number): number {
  let value = 0;
  for (let k = 0; k < 4; k++) {
    const c = query.charCodeAt(pos + k);
    if (!isHex(c)) throw invalidEscape(query, offset, "expected four hexadecimal digits");
    value = value * 16 + hexValue(c);
  }
  return value;
}

/** End of the string literal opened at `start`; validates every escape. */
function stringEnd(query: string, start: number, quote: number): number {
  const n = query.length;
  let pos = start + 1;
  while (pos < n) {
    const c = query.charCodeAt(pos);
    if (c === quote) return pos + 1;
    if (c !== 92) {
      pos++;
      continue;
    }
    const offset = pos++;
    if (pos >= n) throw invalidEscape(query, offset, "dangling backslash");
    const e = query.charCodeAt(pos);
    if (
      e === 39 ||
      e === 34 ||
      e === 92 ||
      e === 47 ||
      e === 98 ||
      e === 102 ||
      e === 110 ||
      e === 114 ||
      e === 116
    ) {
      pos++;
    } else if (e === 117) {
      pos++;
      if (query.charCodeAt(pos) === 123) {
        const digitsStart = ++pos;
        let value = 0;
        while (pos < n && isHex(query.charCodeAt(pos))) {
          value = value * 16 + hexValue(query.charCodeAt(pos));
          if (value > 0x10ffff) throw invalidEscape(query, offset, "invalid Unicode scalar value");
          pos++;
        }
        if (pos === digitsStart || query.charCodeAt(pos) !== 125) {
          throw invalidEscape(query, offset, "expected hexadecimal digits and closing brace");
        }
        if (value >= 0xd800 && value <= 0xdfff) {
          throw invalidEscape(query, offset, "invalid Unicode scalar value");
        }
        pos++;
      } else {
        const value = hex4(query, pos, offset);
        pos += 4;
        if (value >= 0xd800 && value <= 0xdbff) {
          if (query.charCodeAt(pos) !== 92 || query.charCodeAt(pos + 1) !== 117) {
            throw invalidEscape(query, offset, "unpaired high surrogate");
          }
          const second = pos;
          pos += 2;
          const low = hex4(query, pos, second);
          pos += 4;
          if (!(low >= 0xdc00 && low <= 0xdfff)) {
            throw invalidEscape(query, offset, "unpaired high surrogate");
          }
        } else if (value >= 0xdc00 && value <= 0xdfff) {
          throw invalidEscape(query, offset, "unpaired low surrogate");
        }
      }
    } else {
      throw invalidEscape(query, offset, "unknown escape sequence");
    }
  }
  throw new SyntaxError(`unterminated string at UTF-8 byte offset ${utf8Offset(query, start)}`);
}

/** End of the token starting at `start`, which is not whitespace or a comment. */
export function tokenEnd(query: string, start: number): number {
  const c = query.charCodeAt(start);
  if (c === 34 || c === 39) return stringEnd(query, start, c);
  const n = query.length;
  let pos = start + 1;
  if (isDigitCode(c)) {
    while (pos < n && isDigitCode(query.charCodeAt(pos))) pos++;
    if (query.charCodeAt(pos) === 46 && isDigitCode(query.charCodeAt(pos + 1))) {
      pos += 2;
      while (pos < n && isDigitCode(query.charCodeAt(pos))) pos++;
    }
    const e = query.charCodeAt(pos);
    if (e === 101 || e === 69) {
      pos++;
      const s = query.charCodeAt(pos);
      if (s === 43 || s === 45) pos++;
      while (pos < n && isDigitCode(query.charCodeAt(pos))) pos++;
    }
  } else if (isWordCode(c)) {
    while (pos < n && isWordCode(query.charCodeAt(pos))) pos++;
  } else if (c === 46 && query.charCodeAt(pos) === 46) {
    pos++;
    if (query.charCodeAt(pos) === 46) pos++;
  } else if (compound(c, query.charCodeAt(pos))) {
    pos++;
  } else if (c >= 0xd800 && c <= 0xdbff) {
    pos++; // well-formed input: the low surrogate completes this scalar
  }
  return pos;
}

/**
 * Whether the token `left[ls, le)` followed by `right[rs, re)` would lex differently without a separator.
 * `after` is the character code that follows the right token (`NaN` at the end).
 */
export function needsSeparator(
  left: string,
  ls: number,
  le: number,
  right: string,
  rs: number,
  re: number,
  after: number,
): boolean {
  const last = left.charCodeAt(le - 1);
  const first = right.charCodeAt(rs);
  const leftLength = le - ls;
  if (isWordCode(last) && isWordCode(first)) return true;
  if (isDigitCode(left.charCodeAt(ls))) {
    if ((last === 101 || last === 69) && (first === 43 || first === 45)) return true;
    if (leftLength >= 2 && (last === 43 || last === 45) && isDigitCode(first)) {
      const e = left.charCodeAt(le - 2);
      if (e === 101 || e === 69) return true;
    }
  }
  if (isDigitCode(last) && re - rs === 1 && first === 46 && isDigitCode(after)) return true;
  if (leftLength === 1 && last === 46 && isDigitCode(first)) return true;
  if (
    first === 46 &&
    last === 46 &&
    (leftLength === 1 || (leftLength === 2 && left.charCodeAt(ls) === 46))
  ) {
    return true;
  }
  return leftLength === 1 && (compound(last, first) || (last === 47 && first === 47));
}

/**
 * Walks the tokens of a query, skipping whitespace and comments. Allocation-free, so the minifier can use it
 * directly; `tokenize` builds token objects on top of it.
 */
export class Scanner {
  /** Start of the current token, in UTF-16 code units. */
  start = 0;
  /** End of the current token (exclusive). */
  end = 0;
  /** Where the whitespace and comments before the current token begin (`start` when there are none). */
  triviaStart = 0;
  private pos = 0;

  constructor(readonly query: string) {}

  /** Advances to the next token; returns false at the end, with `triviaStart` at the trailing trivia. */
  next(): boolean {
    const query = this.query;
    const n = query.length;
    let pos = this.pos;
    this.triviaStart = pos;
    while (pos < n) {
      const c = query.charCodeAt(pos);
      if (isWhitespaceCode(c)) {
        pos++;
      } else if (c === 47 && query.charCodeAt(pos + 1) === 47) {
        const lf = query.indexOf("\n", pos + 2);
        pos = lf < 0 ? n : lf;
      } else {
        this.start = pos;
        this.end = this.pos = tokenEnd(query, pos);
        return true;
      }
    }
    this.start = this.end = this.pos = n;
    return false;
  }

  /** Whether whitespace or a comment precedes the current token. */
  get spaceBefore(): boolean {
    return this.triviaStart !== this.start;
  }
}

export type TokenKind = "string" | "number" | "identifier" | "punctuator";

export interface Token {
  kind: TokenKind;
  /** The token's spelling. */
  text: string;
  /** UTF-16 span in the query. */
  start: number;
  end: number;
  /** UTF-8 span in the query. */
  byteStart: number;
  byteEnd: number;
  /** Whether whitespace or a comment precedes the token. */
  spaceBefore: boolean;
}

function kindOf(c: number): TokenKind {
  if (c === 34 || c === 39) return "string";
  if (isDigitCode(c)) return "number";
  if (isWordCode(c)) return "identifier";
  return "punctuator";
}

/**
 * Splits a query into tokens with UTF-16 and UTF-8 spans.
 * @throws {TypeError} Non-string input or unpaired UTF-16 surrogates.
 * @throws {SyntaxError} Unterminated strings and invalid escapes, with a zero-based UTF-8 byte offset.
 */
export function tokenize(query: string): Token[] {
  assertQuery(query);
  const tokens: Token[] = [];
  const scanner = new Scanner(query);
  let position = 0;
  let bytes = 0;
  while (scanner.next()) {
    const { start, end } = scanner;
    const byteStart = bytes + utf8Length(query, position, start);
    const byteEnd = byteStart + utf8Length(query, start, end);
    tokens.push({
      kind: kindOf(query.charCodeAt(start)),
      text: query.slice(start, end),
      start,
      end,
      byteStart,
      byteEnd,
      spaceBefore: scanner.spaceBefore,
    });
    position = end;
    bytes = byteEnd;
  }
  return tokens;
}

/**
 * Joins token spellings with a space only where the tokens would otherwise lex differently, using the same
 * rules as the minifier.
 */
export function joinTokens(texts: readonly string[]): string {
  const n = texts.length;
  if (n === 0) return "";
  const spaced = new Uint8Array(n);
  // Right to left: whether a boundary needs a space depends on the character after the right token.
  for (let i = n - 2; i >= 0; i--) {
    const left = texts[i] as string;
    const right = texts[i + 1] as string;
    const after = spaced[i + 1] ? 32 : (texts[i + 2]?.charCodeAt(0) ?? Number.NaN);
    if (needsSeparator(left, 0, left.length, right, 0, right.length, after)) spaced[i] = 1;
  }
  let out = texts[0] as string;
  for (let i = 1; i < n; i++) out += spaced[i - 1] ? ` ${texts[i]}` : texts[i];
  return out;
}
