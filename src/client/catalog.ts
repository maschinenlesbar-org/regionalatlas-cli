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
import { RegionalatlasParseError, RegionalatlasValidationError } from "./errors.js";
import { GEO_LEVELS } from "./levels.js";

/** Derive the SQL table name from a catalogue code: lowercase, `-` → `_`. */
export function tableForCode(code: string): string {
  return code.toLowerCase().replace(/-/g, "_");
}

/** Normalise a user indicator string to compare against a code or a table form. */
function normalizeIndicatorKey(input: string): string {
  return input.trim().toLowerCase().replace(/-/g, "_");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
    if (code === "") continue;
    fields.push({ code, title: asString(a.title_short), unit: asString(a.unit) });
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
  return name.trim().toLowerCase().replace(/-/g, "_");
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

/** Parse the raw services.json array into a flat list of indicators. */
export function parseIndicators(raw: unknown): Indicator[] {
  if (!Array.isArray(raw)) {
    throw new RegionalatlasParseError(
      "Unexpected catalogue shape: expected a JSON array of themes from services.json.",
    );
  }
  const catalog = raw as RawCatalog;
  const out: Indicator[] = [];
  for (const theme of catalog) {
    if (theme === null || typeof theme !== "object") continue;
    const t = theme as RawCatalogTheme;
    const themeTitle = asString(t.title);
    const children = Array.isArray(t.children) ? t.children : [];
    for (const child of children) {
      if (child === null || typeof child !== "object") continue;
      const c = child as RawCatalogIndicator;
      const code = asString(c.code);
      if (code === "") continue;
      const rawYears =
        c.years && typeof c.years === "object" ? (c.years as Record<string, unknown>) : {};
      const years = Object.keys(rawYears).sort();
      const levels: Record<string, string[]> = Object.create(null);
      for (const year of years) {
        const published = publishedLevels(rawYears[year]);
        if (published !== undefined) levels[year] = published;
      }
      out.push({
        code,
        table: tableForCode(code),
        theme: themeTitle,
        titleShort: asString(c.title_short),
        titleLong: asString(c.title_long),
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
  const catalog = raw as RawCatalog;
  return catalog
    .filter((t): t is RawCatalogTheme => t !== null && typeof t === "object")
    .map((t) => ({
      title: asString(t.title),
      indicatorCount: Array.isArray(t.children) ? t.children.length : 0,
    }));
}

/** Filters for listing indicators. */
export interface IndicatorFilter {
  /** Case-insensitive substring on the theme title. */
  theme?: string;
  /** Membership: the indicator must offer this year. */
  year?: string | number;
  /** Case-insensitive substring over code + short + long titles. */
  search?: string;
}

/** Apply the (optional) filters to a flat indicator list. */
export function filterIndicators(indicators: Indicator[], filter: IndicatorFilter = {}): Indicator[] {
  const theme = filter.theme?.trim().toLowerCase();
  const search = filter.search?.trim().toLowerCase();
  const year = filter.year !== undefined ? String(filter.year) : undefined;

  return indicators.filter((ind) => {
    if (theme && !ind.theme.toLowerCase().includes(theme)) return false;
    if (year && !ind.years.includes(year)) return false;
    if (search) {
      const hay = `${ind.code} ${ind.titleShort} ${ind.titleLong}`.toLowerCase();
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
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new RegionalatlasValidationError("An indicator code is required (e.g. AI002-1-5).");
  }
  const key = normalizeIndicatorKey(trimmed);
  // A code's normalized form equals its table form, so one key matches both the
  // code (case-insensitive, hyphen or underscore) and the table name.
  const match = indicators.find((ind) => ind.table === key);
  if (match === undefined) {
    throw new RegionalatlasValidationError(
      `Unknown indicator "${input}". It is not in the catalogue — list indicators with ` +
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
  const available = indicator.fields.map((f) => `${f.code} (${f.title || f.unit || "—"})`);
  throw new RegionalatlasValidationError(
    `Unknown value ${unknown.length > 1 ? "fields" : "field"} ` +
      `${unknown.map((f) => JSON.stringify(f)).join(", ")} for indicator "${indicator.code}". ` +
      `Available: ${available.join("; ")}.`,
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
  if (!Number.isInteger(year)) {
    throw new RegionalatlasValidationError(`Year must be an integer, got "${year}".`);
  }
  if (!indicator.years.includes(String(year))) {
    throw new RegionalatlasValidationError(
      `Year ${year} is not available for indicator "${indicator.code}". ` +
        `Available: ${indicator.years.join(", ")}.`,
    );
  }
  return year;
}
