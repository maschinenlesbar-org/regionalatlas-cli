// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { RegionalatlasValidationError } from "./errors.js";

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
