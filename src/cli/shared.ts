// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { RegionalatlasClientOptions } from "../client/client.js";
import { findLevel, GEO_LEVELS, LEVEL_ALIASES } from "../client/levels.js";

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

/** commander value-parser: a 4-digit year (integer 1000..9999). */
export function parseYear(value: string): number {
  if (!/^[0-9]{4}$/.test(value)) {
    throw new InvalidArgumentError("Expected a 4-digit year (e.g. 2020).");
  }
  return Number(value);
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
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
      `looks like a missing value — "${value}" is the next option, consumed because ` +
        "this one was left without a value. Supply the intended term.",
    );
  }
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for `--level`: resolves a friendly name/alias to the
 * canonical level name, rejecting an unknown level at parse time (exit 2) with a
 * clear message. The client re-resolves it (defence in depth) and only the fixed
 * integer `typ` ever enters SQL.
 */
export function parseLevel(value: string): string {
  const level = findLevel(value);
  if (level === undefined) {
    const names = GEO_LEVELS.map((l) => l.name).join(", ");
    throw new InvalidArgumentError(
      `Unknown geo level. Use one of: ${names} (aliases: ${LEVEL_ALIASES.join(", ")}).`,
    );
  }
  return level.name;
}

/**
 * commander value-parser for a comma-separated field list. Splits on commas,
 * trims, and drops empty entries. Field names are validated/projected client-side
 * later, so this only produces a clean array. A repeated option adds to the list
 * (commander passes the previous value): `--fields a --fields b` is `--fields a,b`,
 * where it used to keep only the last one.
 */
export function parseFieldList(value: string, previous?: string[]): string[] {
  const fields = value
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  if (fields.length === 0) {
    throw new InvalidArgumentError("Expected a comma-separated list of field names.");
  }
  return [...(previous ?? []), ...fields];
}

/**
 * commander value-parser for `--base-url` / `--catalog-url`: a non-empty,
 * well-formed URL whose scheme is `http:` or `https:`. Validating here (parse time)
 * rejects a bad scheme (`file:`, `ftp:`, ...) as a usage error (exit 2) with a clear
 * message, rather than letting it reach the transport and surface as a network error
 * (exit 6). The transport re-checks the scheme as defence in depth.
 */
export function parseHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidArgumentError("Expected a valid URL (e.g. https://host/path).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError("Only http: and https: URLs are supported.");
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: `parseHttpUrl`, plus no query or
 * fragment and no surrounding whitespace. The client appends the data path to the
 * base URL as a string, so `?token=abc` or `#frag` would swallow the path.
 * Userinfo is allowed (Node sends it as Basic auth) and redacted in messages.
 */
export function parseBaseUrl(value: string): string {
  parseHttpUrl(value);
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  if (value !== value.trim()) {
    throw new InvalidArgumentError("A base URL cannot have surrounding whitespace.");
  }
  return value;
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
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * Rejects control characters — a CR/LF (or other C0/DEL byte) would otherwise reach
 * Node's HTTP layer and throw an opaque `ERR_INVALID_CHAR`. Tab (0x09) is allowed;
 * checked by char code so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
  }
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
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
