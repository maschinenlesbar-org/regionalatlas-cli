// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_CATALOG_URL, type RegionalatlasClientOptions } from "../client/client.js";
import { DEFAULT_BASE_URL, cleartextProblem, type RetryEvent } from "../client/engine.js";
import { cutForMessage, queryTokensIn } from "../client/errors.js";
import { resolveLevel } from "../client/levels.js";
import { RegionalatlasValidationError } from "../client/errors.js";
import {
  baseUrlProblem,
  fieldsProblem,
  headerValueProblem,
  httpUrlProblem,
  nonEmptyProblem,
  yearProblem,
  type Problem,
} from "../client/validate.js";

/** Run a library rule as a commander value-parser: the reason becomes a usage error. */
function check<T>(value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser: a 4-digit year (1000..9999), checked with the library's
 * yearProblem, as a number.
 */
export function parseYear(value: string): number {
  const reason = yearProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return Number(value);
}

/** commander value-parser: a non-empty (after trimming) string — the library's nonEmptyProblem. */
export function parseNonEmpty(value: string): string {
  const reason = nonEmptyProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Anything shaped like one of this CLI's own options: a long flag (`--fields`) or a
 * single-letter short flag (`-h`). Deliberately narrower than the sibling CLIs'
 * `/^--?[^\s]/`, which would also reject `-1-5` — and here a leading hyphen is
 * ordinary text, because indicator codes are full of them (`--search -1-5` is a
 * real query, and a value parser cannot see whether commander got it as
 * `--search=-1-5`, so there would be no way to escape it).
 */
const OPTION_SHAPED = /^(--[A-Za-z][\w-]*|-[A-Za-z])$/;

/**
 * commander value-parser for a free-text value (a filter term, a region name).
 *
 * Rejects a value shaped like an option, which is almost always the *next option*
 * consumed because this one was left without a value: `--region --fields` silently
 * made "--fields" the region and returned no rows.
 */
export function parseTextArg(value: string): string {
  if (OPTION_SHAPED.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value — "${cutForMessage(value)}" is the next option, consumed because ` +
        "this one was left without a value. Supply the intended term.",
    );
  }
  // A blank filter is the library's rule (nonEmptyProblem), checked again by the client.
  return parseNonEmpty(value);
}

/**
 * commander value-parser for `--level`: the library's resolveLevel, which turns a
 * friendly name/alias into the canonical level name; its RegionalatlasValidationError
 * for an unknown level becomes a usage error (exit 2) with the same message. The
 * client re-resolves it (defence in depth) and only the fixed integer `typ` ever
 * enters SQL.
 */
export function parseLevel(value: string): string {
  try {
    return resolveLevel(value).name;
  } catch (err) {
    if (err instanceof RegionalatlasValidationError) throw new InvalidArgumentError(err.message);
    throw err;
  }
}

/**
 * commander value-parser for a comma-separated field list. Splits on commas and
 * applies the library's fieldsProblem (at least one non-blank name), then trims and
 * drops the empty entries. Field names are validated/projected client-side later.
 * A repeated option adds to the list (commander passes the previous value):
 * `--fields a --fields b` is `--fields a,b`, where it used to keep only the last one.
 */
export function parseFieldList(value: string, previous?: string[]): string[] {
  const parts = value.split(",");
  const reason = fieldsProblem(parts);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  const fields = parts.map((f) => f.trim()).filter((f) => f !== "");
  return [...(previous ?? []), ...fields];
}

/** The accumulating parsers: options using them take several values on purpose. */
const COLLECTORS: ReadonlySet<unknown> = new Set([parseFieldList]);

/**
 * Make giving a single-value option twice a usage error, on `command` and every
 * subcommand. Commander keeps the last value silently: `--region Gera --region Jena`
 * printed Jena alone, and `--base-url a --base-url b` used b, with nothing telling the
 * user that a value was dropped. Repeatable options (`--fields`, documented as
 * "repeatable") and flags without a value are left alone. Call it once on a freshly built
 * program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic || COLLECTORS.has(option.parseArg)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) {
        throw new InvalidArgumentError(`${option.long ?? option.short} was given more than once; it takes one value.`);
      }
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

/**
 * commander value-parser for `--catalog-url`: the library's httpUrlProblem (a
 * non-blank `http:`/`https:` URL without whitespace), reported as a usage error
 * (exit 2) rather than a network error later. The client checks `catalogUrl` the
 * same way when it is built.
 */
export function parseHttpUrl(value: string): string {
  return check(value, httpUrlProblem);
}

/**
 * commander value-parser for `--base-url`: the library's baseUrlProblem —
 * httpUrlProblem plus no query or fragment, since the client appends the data path
 * to the base URL as a string. Userinfo is allowed (Node sends it as Basic auth) and
 * redacted in messages.
 */
export function parseBaseUrl(value: string): string {
  return check(value, baseUrlProblem);
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's headerValueProblem (non-blank, no C0 control or DEL, tab allowed,
 * nothing above U+00FF), reported as a usage error. The client applies the same
 * rule to `userAgent` when it is built.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Drop the characters a terminal may act on from text bound for stderr: C0 controls
 * other than tab and newline (ESC, BEL, CR, …), DEL and C1 (U+009B is the 8-bit CSI).
 * Server and catalogue text is sanitised where it enters a message, but messages
 * also quote the user's own arguments (`Unknown indicator "…"`), which may come from
 * pasted or scripted data. Checked by char code so the source stays free of control
 * bytes.
 */
export function stripTerminalControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)) continue;
    out += text[i];
  }
  return out;
}

export interface GlobalOptions {
  baseUrl?: string;
  catalogUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): RegionalatlasClientOptions {
  const options: RegionalatlasClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.catalogUrl !== undefined) options.catalogUrl = global.catalogUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before any request), each URL the command contacts is
 * checked: the catalogue URL always, the data host's base URL when `usesDataHost` (the
 * `query` command). Plain `http:` to a remote host gets one warning on stderr (a `WARN`
 * record of `regionalatlas.http`, the cleartextProblem sentence) per URL, naming the catalogue URL's token when it carries
 * one. An action runs once per run, so the warning does too; help, version and usage
 * errors never reach an action and never warn. stdout is never touched.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
  usesDataHost = false,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    for (const problem of cleartextProblems(global, usesDataHost)) logOf(deps).warn("http", problem);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/** The cleartext warnings for the URLs a command contacts (see `action`). */
function cleartextProblems(global: GlobalOptions, usesDataHost: boolean): string[] {
  const catalogUrl = global.catalogUrl ?? DEFAULT_CATALOG_URL;
  const token = queryTokensIn(catalogUrl).length > 0 ? ["the catalogue URL's token"] : [];
  const problems = [cleartextProblem(catalogUrl, token, "the catalogue URL")];
  if (usesDataHost) problems.push(cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL));
  return problems.filter((p): p is string => p !== undefined);
}
