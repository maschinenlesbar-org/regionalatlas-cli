// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { RegionalatlasValidationError, cutText } from "./errors.js";

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
    const shown = JSON.stringify(key.length > 100 ? `${cutText(key, 100)}…` : key);
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

/** True for an empty or whitespace-only string. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A blank filter ("" or whitespace only) is invalid: the library would otherwise
 * skip it and return the unfiltered set (every indicator, every region row), which
 * reads as a successful filtered answer.
 */
export const nonEmptyProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * A `fields` projection needs at least one non-blank field name; blank entries next
 * to real names are dropped. A list with no name at all would otherwise return the
 * rows unprojected, every value column included.
 */
export const fieldsProblem: Problem<unknown> = (value) =>
  Array.isArray(value) &&
  value.every((f) => typeof f === "string") &&
  value.some((f) => !isBlank(f as string))
    ? undefined
    : "Expected a comma-separated list of field names.";

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
