// Command group for the Regionalatlas CLI:
//   - `themes`      list the 21 subject areas (title + indicator count)
//   - `indicators`  list indicators (code, short title, years), with filters
//   - `query`       fetch data rows for an indicator at a chosen geo level

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { IndicatorFilter } from "../../client/catalog.js";
import type { QueryOptions } from "../../client/types.js";
import {
  action,
  parseFieldList,
  parseLevel,
  parseNonEmpty,
  parseYear,
  renderJson,
} from "../shared.js";

/** A one-line year range summary (e.g. "2000–2024" or a single year). */
function yearRange(years: string[]): string {
  if (years.length === 0) return "—";
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? String(first) : `${first}–${last}`;
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("themes")
    .description("List the subject areas (Themenbereiche) with their indicator counts")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.themes());
      }),
    );

  program
    .command("indicators")
    .description("List indicators (Indikatoren): code, short title, available years")
    .option("--theme <substr>", "filter by theme title (case-insensitive substring)", parseNonEmpty)
    .option("--year <yyyy>", "only indicators offering this year", parseYear)
    .option("--search <substr>", "filter over code + short + long title (case-insensitive)", parseNonEmpty)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const filter: IndicatorFilter = {};
        if (typeof opts["theme"] === "string") filter.theme = opts["theme"];
        if (typeof opts["year"] === "number") filter.year = opts["year"];
        if (typeof opts["search"] === "string") filter.search = opts["search"];
        const indicators = await client.indicators(filter);
        renderJson(
          deps,
          global,
          indicators.map((ind) => ({
            code: ind.code,
            table: ind.table,
            theme: ind.theme,
            titleShort: ind.titleShort,
            years: yearRange(ind.years),
          })),
        );
      }),
    );

  program
    .command("query")
    .description("Fetch indicator data rows per region (Bundesland / Kreis / Gemeinde)")
    .argument("<indicator-code>", "indicator code (AI002-1-5) or table form (ai002_1_5)", parseNonEmpty)
    .option(
      "--level <level>",
      "geo level: land | regierungsbezirk | kreis | gemeinde",
      parseLevel,
      "land",
    )
    .option("--year <yyyy>", "reporting year (defaults to the indicator's latest)", parseYear)
    .option("--region <name|ags>", "keep only rows matching this name (substring) or AGS", parseNonEmpty)
    .option("--fields <a,b,c>", "keep only these value fields (comma-separated)", parseFieldList)
    .action(
      action(deps, async ({ client, global, opts }, [indicator]) => {
        const query: QueryOptions = {
          indicator: indicator!,
          level: typeof opts["level"] === "string" ? opts["level"] : "land",
        };
        if (typeof opts["year"] === "number") query.year = opts["year"];
        if (typeof opts["region"] === "string") query.region = opts["region"];
        if (Array.isArray(opts["fields"])) query.fields = opts["fields"] as string[];
        renderJson(deps, global, await client.query(query));
      }),
    );
}
