// The indicator catalogue: parse the raw services.json into flat `Theme`/
// `Indicator` lists, filter them, and — crucially — resolve a user-supplied
// indicator string against the catalogue allowlist.
//
// The catalogue is the security boundary for the raw SQL query: the only table
// name ever interpolated into SQL is the `table` of a *matched* catalogue entry,
// never raw user text.

import type {
  Indicator,
  IndicatorField,
  RawCatalog,
  RawCatalogAttribute,
  RawCatalogIndicator,
  RawCatalogTheme,
  Theme,
} from "./types.js";
import { RegionalatlasParseError, RegionalatlasValidationError, cutForMessage, listForMessage } from "./errors.js";

/** The longest column code or title (in characters) the unknown-field message lists. */
const MAX_LISTED_ITEM_LENGTH = 60;
import { GEO_LEVELS } from "./levels.js";
import { sanitizeServerText } from "./engine.js";
import { BOUNDARY_TABLE } from "./sql.js";
import { assertKnownKeys, assertValid, nonEmptyProblem, normalizeInput, YEAR_SHAPE, yearProblem } from "./validate.js";

/** Derive the SQL table name from a catalogue code: lowercase, `-` → `_`. */
export function tableForCode(code: string): string {
  return code.toLowerCase().replace(/-/g, "_");
}

/** Normalise a user indicator string to compare against a code or a table form. */
function normalizeIndicatorKey(input: string): string {
  return normalizeInput(input).toLowerCase().replace(/-/g, "_");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A text of the catalogue (a title, a unit, a theme name), made safe for stderr.
 * The catalogue is a separate host from the data host (`--catalog-url`), and its
 * texts end up in error messages ("Available: ai0201 (<title>)"), so a control or
 * bidi character in it must not reach the terminal (`sanitizeServerText`).
 */
function catalogText(value: unknown): string {
  return typeof value === "string" ? sanitizeServerText(value) : "";
}

/**
 * The shape of a catalogue indicator code (`AI002-1-5`, `AI-Z1-2011`, `AIGG-01`):
 * letters and digits, joined by hyphens or underscores. The code becomes the SQL
 * table name, so an entry whose code has any other character is left out when the
 * catalogue is parsed — before `sql.ts`'s last-line assert would refuse it with an
 * internal error.
 */
const CODE_SHAPE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

/** A value-column name after `fieldKey`: lower-case letters, digits, underscores. */
const FIELD_SHAPE = /^[a-z0-9_]+$/;

/** The code of a raw catalogue child, or `undefined` when the entry is not a usable indicator. */
function indicatorCode(child: unknown): string | undefined {
  if (child === null || typeof child !== "object") return undefined;
  const code = (child as RawCatalogIndicator).code;
  return typeof code === "string" && CODE_SHAPE.test(code) ? code : undefined;
}

/**
 * Parse an indicator's `attributes` array into the field dictionary.
 *
 * This is the only place a value column's meaning is available: the data query
 * returns bare field names (`ai0201`) whose ArcGIS `alias` just repeats the name,
 * and the suffix carries no meaning either — `AI005` numbers the parties `ai0501`
 * to `ai0505` and `ai0507`, with `ai0506` being turnout. Codes go through
 * `fieldKey` so they match the keys of a parsed `RegionRow.values`: the Zensus 2011
 * indicators list their columns as `AI-Z01`, while the data host returns them as
 * `ai_z01` — the same `-` → `_` mapping that turns a code into its table name.
 */
function parseFields(raw: unknown): IndicatorField[] {
  if (!Array.isArray(raw)) return [];
  const fields: IndicatorField[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const a = entry as RawCatalogAttribute;
    const code = fieldKey(asString(a.code));
    if (!FIELD_SHAPE.test(code)) continue;
    fields.push({ code, title: catalogText(a.title_short), unit: catalogText(a.unit) });
  }
  return fields;
}

/**
 * The canonical form of a value-column name: trimmed, lower-case, `-` → `_`. The
 * data host names the columns in this form (`ai0201`, `ai_z01`), so both the
 * catalogue's spelling (`AI-Z01`) and the data's spelling match. Used by
 * `findField` and by `projectFields`.
 */
export function fieldKey(name: string): string {
  return normalizeInput(name).toLowerCase().replace(/-/g, "_");
}

/**
 * Look up one of an indicator's value columns by name, case-insensitively and
 * with `-` and `_` treated alike — the same matching `projectFields` applies.
 */
export function findField(indicator: Indicator, name: string): IndicatorField | undefined {
  const key = fieldKey(name);
  return indicator.fields.find((f) => f.code === key);
}

/**
 * The geo levels a catalogue year has figures for, from its `geom_levels`.
 *
 * Each entry of `years[year]` describes one value column and carries
 * `geom_levels: [land, regierungsbezirk, kreis, gemeinde]`, the number of regions
 * with a figure at each level. A level whose count is 0 for every column is not
 * published that year: the data host still answers, but with a row per region whose
 * values are all null (live: `AIGG-01` at `kreis`, `AI008-2` in 2006 at `land`), or
 * with a Land figure joined onto a finer row (Berlin and Hamburg).
 *
 * Returns `undefined` when the entry does not have that shape (no entries, or one
 * without four non-negative counts): then nothing is known and nothing is checked.
 */
function publishedLevels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const published = GEO_LEVELS.map(() => false);
  for (const entry of raw) {
    const counts: unknown =
      entry !== null && typeof entry === "object" ? (entry as { geom_levels?: unknown }).geom_levels : undefined;
    if (!Array.isArray(counts) || counts.length !== GEO_LEVELS.length) return undefined;
    for (let i = 0; i < counts.length; i++) {
      const n: unknown = counts[i];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
      if (n > 0) published[i] = true;
    }
  }
  return GEO_LEVELS.filter((_, i) => published[i]).map((l) => l.name);
}

/**
 * Fail closed on a code the SQL join must never see: one whose table is the boundary
 * table (the join would read the boundary table twice), or one whose table another code
 * already names (`DUP-1` and `dup_1` are both `dup_1`, so one of them would be
 * unreachable, and which one a query gets would depend on the catalogue's order). The
 * catalogue host is not trusted with that: the whole catalogue is refused with a
 * RegionalatlasParseError naming the code(s). The public catalogue has neither.
 */
function assertUsableTable(code: string, table: string, seen: Map<string, string>): void {
  const show = (c: string): string => JSON.stringify(cutForMessage(sanitizeServerText(c)));
  if (table === BOUNDARY_TABLE) {
    throw new RegionalatlasParseError(
      `Refusing the indicator catalogue: the code ${show(code)} names the boundary table ${BOUNDARY_TABLE}, ` +
        "which every data query joins the indicator to.",
    );
  }
  const first = seen.get(table);
  if (first !== undefined) {
    throw new RegionalatlasParseError(
      `Refusing the indicator catalogue: the codes ${show(first)} and ${show(code)} name the same table ` +
        `${cutForMessage(table)} (codes are case-insensitive, "-" and "_" alike).`,
    );
  }
  seen.set(table, code);
}

/**
 * Parse the raw services.json array into a flat list of indicators. A catalogue with a
 * code that names the boundary table, or two codes naming the same table, is refused
 * (RegionalatlasParseError).
 */
export function parseIndicators(raw: unknown): Indicator[] {
  if (!Array.isArray(raw)) {
    throw new RegionalatlasParseError(
      "Unexpected catalogue shape: expected a JSON array of themes from services.json.",
    );
  }
  const catalog = raw as RawCatalog;
  const out: Indicator[] = [];
  /** Table name → the first code that named it. */
  const seen = new Map<string, string>();
  for (const theme of catalog) {
    if (theme === null || typeof theme !== "object") continue;
    const t = theme as RawCatalogTheme;
    const themeTitle = catalogText(t.title);
    const children = Array.isArray(t.children) ? t.children : [];
    for (const child of children) {
      // An entry without a well-formed code, and a year key that is not a plain
      // 4-digit year, are left out here, so what `indicators`, `themes` and the
      // default year see is what the SQL guard accepts.
      const code = indicatorCode(child);
      if (code === undefined) continue;
      const c = child as RawCatalogIndicator;
      const rawYears =
        c.years && typeof c.years === "object" ? (c.years as Record<string, unknown>) : {};
      const years = Object.keys(rawYears)
        .filter((y) => YEAR_SHAPE.test(y))
        .sort();
      const levels: Record<string, string[]> = Object.create(null);
      for (const year of years) {
        const published = publishedLevels(rawYears[year]);
        if (published !== undefined) levels[year] = published;
      }
      const table = tableForCode(code);
      assertUsableTable(code, table, seen);
      out.push({
        code,
        table,
        theme: themeTitle,
        titleShort: catalogText(c.title_short),
        titleLong: catalogText(c.title_long),
        years,
        levels,
        fields: parseFields(c.attributes),
      });
    }
  }
  return out;
}

/** Parse the raw services.json into a list of themes with their indicator counts. */
export function parseThemes(raw: unknown): Theme[] {
  if (!Array.isArray(raw)) {
    throw new RegionalatlasParseError(
      "Unexpected catalogue shape: expected a JSON array of themes from services.json.",
    );
  }
  // The same checks as `indicators`: a catalogue it refuses is refused here too.
  parseIndicators(raw);
  const catalog = raw as RawCatalog;
  return catalog
    .filter((t): t is RawCatalogTheme => t !== null && typeof t === "object")
    .map((t) => ({
      title: catalogText(t.title),
      // Count what `indicators` lists: entries with a well-formed code.
      indicatorCount: Array.isArray(t.children)
        ? t.children.filter((c) => indicatorCode(c) !== undefined).length
        : 0,
    }));
}

/** The keys an {@link IndicatorFilter} takes; any other key is refused. */
export const INDICATOR_FILTER_KEYS: readonly string[] = Object.freeze(["theme", "year", "search"]);

/** Filters for listing indicators. Omit a filter to skip it; a blank one is refused. */
export interface IndicatorFilter {
  /** Case-insensitive substring on the theme title (not blank). */
  theme?: string;
  /** Membership: the indicator must offer this year (a 4-digit year, number or string). */
  year?: string | number;
  /** Case-insensitive substring over code + short + long titles (not blank). */
  search?: string;
}

/**
 * Check an indicator filter before the catalogue is fetched: an object with no key but
 * `theme`, `year` and `search` (`assertKnownKeys`), a `theme` or `search`
 * that is set must not be blank ("" or whitespace), because a blank filter would
 * match every indicator, and a `year` must be a 4-digit year (`normaliseYearFilter`).
 * Throws `RegionalatlasValidationError` (`Invalid search: Expected a non-empty value.`).
 */
export function assertIndicatorFilter(filter: IndicatorFilter): void {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    throw new RegionalatlasValidationError("Invalid indicator filter: expected an object (theme, year, search).");
  }
  assertKnownKeys("indicator filter", filter, INDICATOR_FILTER_KEYS);
  if (filter.theme !== undefined) assertValid("theme", filter.theme, nonEmptyProblem);
  if (filter.year !== undefined) normaliseYearFilter(filter.year);
  if (filter.search !== undefined) assertValid("search", filter.search, nonEmptyProblem);
}

/**
 * The canonical form of a year filter: the year as the 4-digit string the catalogue
 * keys use. Accepts an integer (`2020`) or an unpadded 4-digit string (`"2020"`);
 * anything else (`" 2020"`, `""`, `1.5`, `20`, `"02020"`) throws
 * `RegionalatlasValidationError` (`Invalid year: Expected a 4-digit year (e.g. 2020).`)
 * instead of matching nothing or being skipped.
 */
export function normaliseYearFilter(year: string | number): string {
  return String(assertValid("year", year, yearProblem));
}

/**
 * Fold text for a case-insensitive comparison: NFC first, so a decomposed umlaut
 * ("o" + U+0308, as pasted from macOS file names and some input methods) matches
 * the catalogue's and the data's composed "ö". Applied to both sides.
 */
export function foldText(text: string): string {
  return normalizeInput(text).toLowerCase();
}

/**
 * Apply the (optional) filters to a flat indicator list. A blank `theme` or
 * `search` throws `RegionalatlasValidationError` (`assertIndicatorFilter`).
 */
export function filterIndicators(indicators: Indicator[], filter: IndicatorFilter = {}): Indicator[] {
  assertIndicatorFilter(filter);
  const theme = filter.theme === undefined ? undefined : foldText(filter.theme.trim());
  const search = filter.search === undefined ? undefined : foldText(filter.search.trim());
  const year = filter.year !== undefined ? normaliseYearFilter(filter.year) : undefined;

  return indicators.filter((ind) => {
    if (theme !== undefined && !foldText(ind.theme).includes(theme)) return false;
    if (year !== undefined && !ind.years.includes(year)) return false;
    if (search !== undefined) {
      const hay = foldText(`${ind.code} ${ind.titleShort} ${ind.titleLong}`);
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Resolve a user-supplied indicator string against the catalogue allowlist. Accepts
 * either the code form (`AI002-1-5`, case-insensitive) or the table form
 * (`ai002_1_5`). Throws a typed validation error if not found — BEFORE any SQL is
 * built. The returned indicator's `table` is the only value interpolated into SQL.
 */
export function resolveIndicator(indicators: Indicator[], input: string): Indicator {
  assertIndicatorInput(input);
  const trimmed = input.trim();
  const key = normalizeIndicatorKey(trimmed);
  // A code's normalized form equals its table form, so one key matches both the
  // code (case-insensitive, hyphen or underscore) and the table name.
  const match = indicators.find((ind) => ind.table === key);
  if (match === undefined) {
    throw new RegionalatlasValidationError(
      `Unknown indicator "${cutForMessage(input)}". It is not in the catalogue — list indicators with ` +
        `\`regionalatlas indicators\` (accepts the code form AI002-1-5 or the table form ai002_1_5).`,
    );
  }
  return match;
}

/**
 * Validate requested value-field names against the indicator's field dictionary.
 *
 * `projectFields` ignores a name it does not recognise — correct, because no user
 * text may reach the SQL — but that turned a typo into a full set of rows whose
 * `values` were all `{}`, which reads as "this indicator has no data here" rather
 * than "you mistyped". Failing here makes it a usage error, matching how an
 * unknown indicator, level and year are already handled.
 *
 * Skipped when the catalogue lists no attributes for the indicator: the dictionary
 * is a convenience, and an upstream that stops publishing it must not break queries.
 */
export function assertKnownFields(indicator: Indicator, fields: string[]): void {
  if (indicator.fields.length === 0) return;
  const unknown = fields.filter((f) => f.trim() !== "" && findField(indicator, f) === undefined);
  if (unknown.length === 0) return;
  // Every part cut and the lists bounded: the catalogue is a second trust domain, and a
  // typed name can be of any length.
  const available = indicator.fields.map(
    (f) => `${cutForMessage(f.code, MAX_LISTED_ITEM_LENGTH)} (${cutForMessage(f.title || f.unit || "—", MAX_LISTED_ITEM_LENGTH)})`,
  );
  throw new RegionalatlasValidationError(
    `Unknown value ${unknown.length > 1 ? "fields" : "field"} ` +
      `${listForMessage(unknown.map((f) => JSON.stringify(cutForMessage(f, MAX_LISTED_ITEM_LENGTH))), ", ")} ` +
      `for indicator "${indicator.code}". Available: ${listForMessage(available, "; ")}.`,
  );
}

/**
 * Refuse a level the catalogue says has no figures for this indicator and year.
 *
 * The data query would still return a row for every region of the level, all of
 * them `null` — which reads as "no figure for these regions" when the indicator is
 * not published at that level at all (`AIGG-01` exists only per Land). Skipped when
 * the catalogue carries no usable `geom_levels` for the year.
 */
export function assertLevelPublished(indicator: Indicator, level: string, year: number): void {
  const published = indicator.levels[String(year)];
  if (published === undefined || published.includes(level)) return;
  const yearsAtLevel = indicator.years.filter((y) => {
    const p = indicator.levels[y];
    return p === undefined || p.includes(level);
  });
  const otherYears =
    yearsAtLevel.length > 0
      ? ` Years with figures at level ${level}: ${yearsAtLevel.join(", ")}.`
      : ` The catalogue lists no year with figures at level ${level}.`;
  if (published.length === 0) {
    throw new RegionalatlasValidationError(
      `Indicator "${indicator.code}" has no figures for ${year} at any level (the catalogue ` +
        `publishes none), so every row would be null.${otherYears}`,
    );
  }
  // Suggest the published level closest to the requested one (the coarser on a tie).
  const rank = (name: string): number => GEO_LEVELS.findIndex((l) => l.name === name);
  const wanted = rank(level);
  const nearest = [...published].sort(
    (a, b) => Math.abs(rank(a) - wanted) - Math.abs(rank(b) - wanted) || rank(a) - rank(b),
  )[0];
  throw new RegionalatlasValidationError(
    `Indicator "${indicator.code}" has no figures at level ${level} in ${year}: the catalogue ` +
      `publishes it only at ${published.length > 1 ? "levels" : "level"} ${published.join(", ")}, ` +
      `so every ${level} row would be null. Use --level ${nearest}.${otherYears}`,
  );
}

/**
 * Check the indicator argument's type and content, before the catalogue is fetched: a
 * non-empty string. A plain-JS caller's number, `null` or object threw a raw
 * `TypeError` ("input.trim is not a function") after the catalogue request.
 */
export function assertIndicatorInput(input: unknown): asserts input is string {
  if (typeof input !== "string") {
    throw new RegionalatlasValidationError(
      `Invalid indicator: expected the indicator code as a string (e.g. "AI002-1-5"), got ${input === null ? "null" : typeof input}.`,
    );
  }
  if (input.trim() === "") {
    throw new RegionalatlasValidationError("An indicator code is required (e.g. AI002-1-5).");
  }
}

/** Check a query year's type before any request: an integer (its range is checked against the catalogue). */
export function assertYearInput(year: unknown): asserts year is number {
  if (typeof year !== "number" || !Number.isInteger(year)) {
    const shown = typeof year === "string" ? JSON.stringify(year) : String(year);
    throw new RegionalatlasValidationError(`Year must be an integer, got ${cutForMessage(shown)}.`);
  }
}

/**
 * Validate and resolve the year for an indicator. When `year` is undefined, the
 * latest available year is used. A provided year must be an integer AND present in
 * the indicator's catalogue years. Only the validated integer enters SQL.
 */
export function resolveYear(indicator: Indicator, year?: number): number {
  if (indicator.years.length === 0) {
    throw new RegionalatlasValidationError(
      `Indicator "${indicator.code}" has no years listed in the catalogue.`,
    );
  }
  if (year === undefined) {
    // Latest available year (years are 4-digit strings; compare numerically).
    return Math.max(...indicator.years.map((y) => Number(y)));
  }
  assertYearInput(year);
  if (!indicator.years.includes(String(year))) {
    throw new RegionalatlasValidationError(
      `Year ${year} is not available for indicator "${indicator.code}". ` +
        `Available: ${listForMessage(indicator.years, ", ")}.`,
    );
  }
  return year;
}
