// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { RegionalatlasValidationError, quoteValue } from "./errors.js";

/** A rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link RegionalatlasValidationError} with the message
 * `Invalid <name>: <reason>` when `problem(value)` finds a reason; otherwise return
 * `value` unchanged. Call it before any request, so a rejected input sends nothing.
 * Async methods call it inside their body, so the rejection arrives as a rejected
 * promise rather than a synchronous throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new RegionalatlasValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** The edit distance of two short strings (for a "did you mean" hint). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Refuse an options object with a key the call doesn't take: `{ serach: "x" }` or
 * `{ levle: "kreis" }` used to be ignored silently, so the call answered with the whole
 * catalogue or the default level, which reads as a filtered answer. Own keys only, so a
 * `__proto__` or `constructor` key (from JSON.parse) is caught too. Throws
 * `RegionalatlasValidationError` (`Invalid <name>: unknown key "serach" (did you mean
 * "search"?); known keys: theme, year, search.`). Nothing is sent for these keys —
 * regionalatlas filters on the client — so there is no opt-out: an unknown key can only
 * be a mistake.
 */
export function assertKnownKeys(name: string, value: object, known: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    const near = known.find((k) => k.toLowerCase() === key.toLowerCase() || editDistance(k, key) <= 2);
    const shown = quoteValue(key, 100);
    throw new RegionalatlasValidationError(
      `Invalid ${name}: unknown key ${shown}${near === undefined ? "" : ` (did you mean "${near}"?)`}; ` +
        `known keys: ${known.join(", ")}.`,
    );
  }
}

/**
 * The one normal form for a name or code a user types: trimmed and in Unicode NFC, so a
 * decomposed umlaut ("a" + U+0308, as macOS file names and some input methods produce)
 * reads like the composed one. `--level bundesländer` typed decomposed was "Unknown geo
 * level" with a message that rendered identically to the accepted alias. Case-folding is
 * left to the caller, where the lookup is case-insensitive.
 */
export function normalizeInput(value: string): string {
  return value.trim().normalize("NFC");
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which a JSON printer writes as `\ud800` and jq refuses. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace (U+00A0 and
 * U+3000 included), control and format characters (a zero-width space, a soft hyphen) and
 * combining marks. Such a filter reads as "no filter", or matches nothing, so it is refused as
 * blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be used as a text filter (`theme`, `search`, `region`), or undefined when it
 * can. Refused, before any request, as it would match nothing or everything:
 * - a value of another type (`Expected a string, got a number.`);
 * - a value that is blank once trimmed, or holds only invisible characters and combining marks
 *   (`isBlank`): an empty filter reads as "no filter", which answers with the whole list;
 * - a lone surrogate (half of a character);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the filter match
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return `Expected a string, got ${kindOf(value)}.`;
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be used as a token, or undefined when it can. A token is a value compared
 * exactly: the indicator code, a value-field name. The rules apply to the value with surrounding
 * whitespace trimmed, as it is used (`normalizeToken`): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in a
 * code only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return `Expected a string, got ${kindOf(value)}.`;
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is used: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--fields a,b`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"a, b"` uses `b`, and
 * `"a,,b"`, `"a,"` and `","` are refused rather than dropped.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be used as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<unknown> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i]);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** What a wrong-typed value is, for a message: "a number", "an array", "null", "undefined", … */
export function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/**
 * A text filter must be a string, and a blank one ("" or whitespace only) is invalid: the
 * library would otherwise skip it and return the unfiltered set (every indicator, every
 * region row), which reads as a successful filtered answer. A value of another type is
 * named as such (`Expected a string, got a number.`), not called empty.
 */
export const nonEmptyProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return `Expected a string, got ${kindOf(value)}.`;
  return value.trim() === "" ? "Expected a non-empty value." : undefined;
};

/**
 * `nonEmptyProblem` for a `region`, whose most likely wrong type is a number: an AGS from
 * plain JavaScript (`region: 9`), where the key's leading zero would be lost anyway.
 */
export const regionProblem: Problem<unknown> = (value) =>
  typeof value === "string" ? textProblem(value) : `Expected the region as a string (a name, or an AGS such as "09"), got ${kindOf(value)}.`;

/**
 * A `fields` projection is a non-empty array of field names, each a token (`tokenProblem`): a
 * blank or invisible item is refused, never dropped (a list with no name at all would return
 * the rows unprojected, every value column included). A string (the CLI's comma-separated form)
 * is named as such: the library wants the names split.
 */
export const fieldsProblem: Problem<unknown> = (value) => {
  const expected = 'Expected an array of field names (["ai0201", "ai0202"])';
  if (typeof value === "string") return `${expected}, got a string; split a comma-separated list first.`;
  if (!Array.isArray(value)) return `${expected}, got ${kindOf(value)}.`;
  const bad = value.findIndex((f) => typeof f !== "string");
  if (bad >= 0) return `Expected an array of field names, got an item that is ${kindOf(value[bad])}.`;
  return listProblem(value as string[]);
};

/**
 * A 4-digit year, no leading zero: the shape of a catalogue year key, and of a
 * year filter. Years enter SQL as integers, so "0999" is not 999.
 */
export const YEAR_SHAPE = /^[1-9][0-9]{3}$/;

/**
 * A year filter is an integer 1000..9999, or a string of exactly those four digits
 * (no padding, no leading zero, no sign or decimal point). Anything else would only
 * ever match nothing (a false empty list) or, for "", be skipped (the full list).
 */
export const yearProblem: Problem<unknown> = (value) => {
  const ok =
    (typeof value === "number" && Number.isSafeInteger(value) && YEAR_SHAPE.test(String(value))) ||
    (typeof value === "string" && YEAR_SHAPE.test(value));
  return ok ? undefined : "Expected a 4-digit year (e.g. 2020).";
};

/**
 * A value that goes into an HTTP header (the User-Agent, a default header):
 * non-blank, no C0 control or DEL (tab is allowed, as in HTTP), nothing above
 * U+00FF. A blank User-Agent is sent empty, which WAFs block; Node's HTTP layer
 * refuses the rest with an opaque "Invalid character in header content" TypeError
 * at request time, and an injected transport would send a CR/LF value as is.
 * Checked by char code so the source stays free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name: an RFC 9110 token. */
export const headerNameProblem: Problem<unknown> = (value) =>
  typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+.^_`|~-).";

/**
 * The shared URL rules, in order: non-blank, no surrounding whitespace, no
 * whitespace or control character inside (new URL() would silently trim or strip
 * them, but the engine concatenates the raw string, and a custom transport gets it
 * as is), parsable, `http:`/`https:` only — and for a base URL no query or
 * fragment, because request paths are appended to it as a string. Userinfo is
 * allowed (Node sends it as Basic auth; messages redact it), but a `%` in it must start
 * a valid escape (`%25` for a literal one). The reasons never repeat the value.
 */
function urlProblem(value: unknown, base: boolean): string | undefined {
  const label = base ? "A base URL" : "A URL";
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  if (value !== value.trim()) return `${label} cannot have surrounding whitespace.`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return `${label} cannot contain whitespace or control characters.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected a valid URL (e.g. https://host/path).";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http: and https: URLs are supported.";
  if (base && /[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo for the Basic-auth header and fails at request time on a
  // "%" that starts no escape; refuse it here, as a usage error, without echoing it.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
}

/** An absolute `http:`/`https:` URL, such as the catalogue URL (`catalogUrl`). */
export const httpUrlProblem: Problem<unknown> = (value) => urlProblem(value, false);

/** The data host's base URL (`baseUrl`): httpUrlProblem, plus no query or fragment. */
export const baseUrlProblem: Problem<unknown> = (value) => urlProblem(value, true);
