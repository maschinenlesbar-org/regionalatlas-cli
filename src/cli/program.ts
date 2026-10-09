// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { RegionalatlasClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { redactUrl } from "../client/errors.js";
import {
  parseIntArg,
  parseBaseUrl,
  parseBoundedInt,
  parseHeaderValue,
  parseHttpUrl,
  forbidRepeatedOptions,
} from "./shared.js";
import { registerCommands } from "./commands/regions.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  env: process.env,
  createClient: (options) => new RegionalatlasClient(options),
};

/** The environment variable that sets the data host's base URL (flag > variable > default). */
export const BASE_URL_ENV = "REGIONALATLAS_BASE_URL";

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();
  // flag > REGIONALATLAS_BASE_URL > default; an empty variable counts as unset.
  const baseUrlDefault = deps.env?.[BASE_URL_ENV] || DEFAULT_BASE_URL;

  program
    .name("regionalatlas")
    .description(
      "CLI for the Regionalatlas Deutschland — regional-statistics indicators of the " +
        "Statistische Ämter des Bundes und der Länder, per Bundesland / Regierungsbezirk / " +
        "Kreis / Gemeinde. No API key needed. `themes` lists the subject areas; `indicators` " +
        "lists the indicators (with --theme/--year/--search filters); `query <code> --level " +
        "<land|kreis|…>` fetches the data rows for a year.",
    )
    .version(VERSION)
    .addOption(
      new Option("--base-url <url>", `ArcGIS data host base URL (env ${BASE_URL_ENV})`)
        .argParser(parseBaseUrl)
        // The help shows the default without userinfo: a password in REGIONALATLAS_BASE_URL
        // must not end up in --help output or CI logs.
        .default(baseUrlDefault, JSON.stringify(redactUrl(baseUrlDefault))),
    )
    .option(
      "--catalog-url <url>",
      "indicator catalogue URL (services.json)",
      parseHttpUrl,
      "https://regionalatlas.statistikportal.de/taskrunner/services.json",
    )
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout)",
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses and reset connections (0..10)",
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  // commander runs value parsers on flags but not on defaults, so a base URL taken from
  // REGIONALATLAS_BASE_URL is checked here, before any command runs (a usage error, exit
  // 2). The message names the variable, not its value (which may hold a password). The
  // help command never makes a request: help must work whatever the variable holds.
  program.hook("preAction", (_program, actionCommand) => {
    if (actionCommand.name() === "help") return;
    if (program.getOptionValueSource("baseUrl") !== "default") return;
    try {
      parseBaseUrl(program.opts<{ baseUrl: string }>().baseUrl);
    } catch (err) {
      if (!(err instanceof InvalidArgumentError)) throw err;
      // No help after this error: it would only repeat the variable's value as the default.
      program.showHelpAfterError(false);
      program.error(`error: ${BASE_URL_ENV}: ${err.message} Fix or unset the variable.`);
    }
  });

  registerCommands(program, deps);
  forbidRepeatedOptions(program);

  return program;
}
