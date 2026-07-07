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
 * later, so this only produces a clean array.
 */
export function parseFieldList(value: string): string[] {
  const fields = value
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  if (fields.length === 0) {
    throw new InvalidArgumentError("Expected a comma-separated list of field names.");
  }
  return fields;
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
