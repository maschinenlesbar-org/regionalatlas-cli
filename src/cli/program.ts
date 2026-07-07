// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { RegionalatlasClient } from "../client/client.js";
import { parseIntArg, parseBoundedInt, parseHeaderValue, parseHttpUrl } from "./shared.js";
import { registerCommands } from "./commands/regions.js";

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
  createClient: (options) => new RegionalatlasClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

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
    .option(
      "--base-url <url>",
      "ArcGIS data host base URL",
      parseHttpUrl,
      "https://www.gis-idmz.nrw.de",
    )
    .option(
      "--catalog-url <url>",
      "indicator catalogue URL (services.json)",
      parseHttpUrl,
      "https://regionalatlas.statistikportal.de/taskrunner/services.json",
    )
    .option("--timeout <ms>", "per-request timeout in ms (0 = no timeout)", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option("--max-retries <n>", "retries for transient 429/503 responses (0..10)", parseBoundedInt(0, 10))
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
