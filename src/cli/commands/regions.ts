// Command group for the Regionalatlas CLI:
//   - `themes`      list the 21 subject areas (title + indicator count)
//   - `indicators`  list indicators (code, titles, years, levels, fields), with filters
//   - `query`       fetch data rows for an indicator at a chosen geo level

import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { resolveIndicator, resolveYear, type IndicatorFilter } from "../../client/catalog.js";
import { DEFAULT_LEVEL } from "../../client/levels.js";
import type { Indicator, QueryOptions, QueryResult, RegionRow } from "../../client/types.js";
import { sanitizeServerText } from "../../client/engine.js";
import { cutForMessage } from "../../client/errors.js";
import {
  action,
  parseFieldList,
  parseLevel,
  parseNonEmpty,
  parseTextArg,
  parseYear,
  renderJson,
} from "../shared.js";

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
    .description("List indicators (Indikatoren): code, titles, years offered, levels per year, value fields")
    .option("--theme <substr>", "filter by theme title (case-insensitive substring)", parseTextArg)
    .option("--year <yyyy>", "only indicators offering this year", parseYear)
    .option("--search <substr>", "filter over code + short + long title (case-insensitive)", parseTextArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const filter: IndicatorFilter = {};
        if (typeof opts["theme"] === "string") filter.theme = opts["theme"];
        if (typeof opts["year"] === "number") filter.year = opts["year"];
        if (typeof opts["search"] === "string") filter.search = opts["search"];
        // The records exactly as the library returns them: every year offered (gaps
        // visible), the geo levels with figures per year, and the value columns.
        const indicators = await client.indicators(filter);
        renderJson(deps, global, indicators);
        if (indicators.length === 0) {
          // `query` explains its empty results; discovery — where the user is most
          // likely to be guessing — should not be the one command that stays silent.
          logOf(deps).info("api", emptyIndicatorsNote(filter, await client.indicators()));
        }
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
      DEFAULT_LEVEL,
    )
    .option("--year <yyyy>", "reporting year (defaults to the newest year in the catalogue)", parseYear)
    .option(
      "--region <name|ags>",
      "keep only the region with this AGS or exact name (else every name containing it; a note says when several match)",
      parseTextArg,
    )
    .option(
      "--fields <a,b,c>",
      "keep only these value fields (comma-separated; repeatable)",
      parseFieldList,
    )
    .action(
      action(deps, async ({ client, global, opts }, [indicator]) => {
        const query: QueryOptions = { indicator: indicator! };
        if (typeof opts["level"] === "string") query.level = opts["level"];
        if (typeof opts["year"] === "number") query.year = opts["year"];
        if (typeof opts["region"] === "string") query.region = opts["region"];
        if (Array.isArray(opts["fields"])) query.fields = opts["fields"] as string[];
        const { rows, fetched, exceededTransferLimit, region } = await client.queryResult(query);
        renderJson(deps, global, rows);
        if (region !== undefined && query.region !== undefined) {
          const note = regionNote(query.region, query.level ?? DEFAULT_LEVEL, region, rows);
          if (note !== undefined) logOf(deps).info("api", note);
        }
        if (exceededTransferLimit) {
          logOf(deps).info(
            "api",
            `the data host stopped at its record limit after ${fetched} rows ` +
              "(exceededTransferLimit), so the result is incomplete. Query a coarser --level.",
          );
        }
        if (rows.length === 0) {
          // An empty result exits 0 like any other; say why on stderr so it isn't read
          // as "this indicator has no data". The catalogue is cached, so no new request.
          const resolved = resolveIndicator(await client.indicators(), query.indicator);
          logOf(deps).info("api", emptyResultNote(resolved, query, fetched));
        }
      }, true),
    );
}

/** Up to five regions as `ags name`, then how many more. */
function regionList(rows: ReadonlyArray<{ ags: string; name: string }>): string {
  const shown = rows.slice(0, 5).map((r) => sanitizeServerText(`${r.ags} ${r.name}`));
  return rows.length > 5 ? `${shown.join(", ")} and ${rows.length - 5} more` : shown.join(", ");
}

/**
 * The stderr note for how `--region` matched, or undefined when there is nothing to say
 * (one row by its key, or one row by a name nothing else contains). The library prefers a
 * whole-name match over substring hits (`matchRegion`), so `Sachsen` is Sachsen alone; the
 * note names what that left out, says when several rows matched (a shared name, or a
 * substring), and when a zero-padded key matched a shorter one, so neither a user nor a
 * script takes the first row of an ambiguous answer for the region it asked about.
 */
export function regionNote(
  input: string,
  level: string,
  match: NonNullable<QueryResult["region"]>,
  rows: readonly RegionRow[],
): string | undefined {
  const asked = JSON.stringify(cutForMessage(input.trim()));
  if (match.by === "ags-filled" && rows[0] !== undefined) {
    return (
      `no row at level ${level} has the key ${asked}; matched ${regionList(rows)}, ` +
      "which this level carries under the shorter key (a level fills in with coarser units)."
    );
  }
  if (rows.length > 1) {
    const how = match.by === "name" ? "share that exact name" : "contain it in their name (no name equals it)";
    return (
      `--region ${asked} is ambiguous: ${rows.length} rows ${how}: ${regionList(rows)}. ` +
      "Pick one region by its AGS (--region <ags>)."
    );
  }
  if (match.by === "name" && match.others.length > 0) {
    return (
      `--region ${asked} matched the name exactly; left out ${match.others.length} ` +
      `${match.others.length > 1 ? "rows that only contain" : "row that only contains"} it: ${regionList(match.others)} ` +
      "(pick one of those by its AGS)."
    );
  }
  return undefined;
}

/**
 * The stderr note for an `indicators` listing that matched nothing. Names the
 * filters that were applied, and — when `--year` is one of them — the years the
 * catalogue actually offers, since that is the filter most often set to a year no
 * indicator has.
 */
function emptyIndicatorsNote(filter: IndicatorFilter, all: Indicator[]): string {
  const applied: string[] = [];
  if (filter.theme !== undefined) applied.push(`--theme ${JSON.stringify(filter.theme)}`);
  if (filter.year !== undefined) applied.push(`--year ${filter.year}`);
  if (filter.search !== undefined) applied.push(`--search ${JSON.stringify(filter.search)}`);
  if (applied.length === 0) {
    return "the catalogue lists no indicators at all — check --catalog-url.";
  }
  let note =
    `none of the ${all.length} catalogue indicators match ${applied.join(" + ")}.`;
  if (filter.year !== undefined) {
    const years = [...new Set(all.flatMap((i) => i.years))].sort();
    const first = years[0];
    const last = years[years.length - 1];
    if (first !== undefined && last !== undefined) {
      note += ` The catalogue covers ${first}–${last}.`;
    }
  }
  return note;
}

/**
 * The stderr note for a query that printed no rows, by cause. When the data host
 * returned rows (`fetched` > 0), only `--region` removed them. When it returned
 * none, the year is the suspect: the catalogue can list a year (typically the
 * newest) that the data host has not loaded yet, so when the year was defaulted,
 * point at the previous catalogue year.
 */
function emptyResultNote(indicator: Indicator, query: QueryOptions, fetched: number): string {
  const year = resolveYear(indicator, query.year);
  const where = `${indicator.code} at level ${query.level ?? DEFAULT_LEVEL} in ${year}`;
  if (fetched > 0) {
    return (
      `none of the ${fetched} rows for ${where} match --region ` +
      `${JSON.stringify(query.region)} (a name, a part of one, or an AGS).`
    );
  }
  let note =
    `the data host returned no rows for ${where}` +
    `${query.region !== undefined ? " (before --region was applied)" : ""}.`;
  if (query.year === undefined) {
    const earlier = indicator.years.map(Number).filter((y) => y < year);
    if (earlier.length > 0) {
      note +=
        ` ${year} is the newest year in the catalogue, but its data may not be loaded yet;` +
        ` try --year ${Math.max(...earlier)}.`;
    }
  }
  return note;
}
