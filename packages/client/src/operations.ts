// The use cases of the skills as library functions, built on the client: each carries the traps
// the skills document, so no caller (the CLI, the MCP server's tools, a library user) has to know
// them.
// - findIndicators: the catalogue searched by topic, theme, year and level, value columns
//   included, each indicator with its years, its levels and its field dictionary
//   (regionalatlas-catalog);
// - getIndicatorMap: one indicator for every region of a level and year, with what each value
//   column measures (regionalatlas-map);
// - compareRegions: one value column for a few named regions, or the highest and lowest of a
//   level, ranked against the whole level (regionalatlas-compare);
// - listThemes: the subject areas and their indicators.
//
// Traps that hold for all of them: an indicator is named by its catalogue code, and a text that
// is no code is answered with the indicators it matches, never taken as one of them. A year the
// catalogue lists can have no figures at a level, or none at all, and the newest one may not be
// loaded on the data host yet: a year the caller left out falls back to the one before, and says
// so. The `values` keys are bare column codes: the field dictionary says what each measures, in
// which unit. A special-value code is no figure (null, with the reason in `missing`), except
// "nichts vorhanden", which is exactly 0, but in a Veränderungsrate column in the indicator's
// first year means "no previous year" (null here), and in a column the catalogue publishes no
// figure for that year is no figure (null, from the client). A region name can stand for several regions:
// ambiguity is reported, never guessed.
//
// Only the catalogue's table name, the level's fixed typ and a year the catalogue lists ever
// reach the data host's SQL (the client builds it, sql.ts asserts it): every text these
// functions take is checked against the catalogue first, and region names and value columns are
// applied to the rows here, never sent.

import type { RegionalatlasClient } from "./client.js";
import { matchRegion, UNPUBLISHED_REASON } from "./client.js";
import { columnPublished, fieldKey, findField, foldText } from "./catalog.js";
import { GEO_LEVELS, resolveLevel } from "./levels.js";
import { assertValid, textProblem, tokenProblem } from "./validate.js";
import { cutText } from "./errors.js";
import type { Indicator, IndicatorField, RegionRow } from "./types.js";

/** What every operation answers: ok, ambiguous (ask which), or empty (with the reason). */
export type OperationStatus = "ok" | "ambiguous" | "empty";

// --- Shared ----------------------------------------------------------------------------------

/**
 * Text folded for a search: case and Unicode form aside (`foldText`), and the umlauts and ß
 * spelled out, so "Bevoelkerung" finds "Bevölkerung" and "bevölk" finds a title spelled "Bevoelk…".
 */
export function searchKey(text: string): string {
  return foldText(text).replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

/** The canonical level names, coarsest first. */
export const LEVEL_NAMES: readonly string[] = GEO_LEVELS.map((level) => level.name);

/** The years (newest first) an indicator has figures at `level`; a year without level data counts. */
function yearsAtLevel(indicator: Indicator, level: string): string[] {
  return indicator.years.filter((year) => indicator.levels[year]?.includes(level) ?? true).reverse();
}

/** The levels an indicator has figures at in any year (coarsest first). */
function levelsOf(indicator: Indicator): string[] {
  return LEVEL_NAMES.filter((level) => yearsAtLevel(indicator, level).length > 0);
}

/** An indicator in a short form: what a list shows of it. */
export interface IndicatorSummary {
  code: string;
  theme: string;
  titleShort: string;
  titleLong: string;
  /** Every year the catalogue offers, ascending (gaps are real). */
  years: string[];
  /** The levels with figures in some year, coarsest first. */
  levels: string[];
  /** Years listed without figures at any level: no query answers them. */
  emptyYears?: string[];
  /** The value columns: what each `values` key measures, and its unit. */
  fields: IndicatorField[];
  /** Per year, the levels with figures (for a single indicator only). */
  levelsByYear?: Record<string, string[]>;
  /** The value columns whose title or code the search matched (when it matched no title). */
  matchedFields?: string[];
}

function summary(indicator: Indicator, detail: boolean): IndicatorSummary {
  const empty = indicator.years.filter((year) => indicator.levels[year]?.length === 0);
  return {
    code: indicator.code,
    theme: indicator.theme,
    titleShort: indicator.titleShort,
    titleLong: indicator.titleLong,
    years: indicator.years,
    levels: levelsOf(indicator),
    ...(empty.length > 0 ? { emptyYears: empty } : {}),
    fields: indicator.fields,
    ...(detail ? { levelsByYear: indicator.levels } : {}),
  };
}

/** The catalogue indicator a code or table form names, or undefined. */
function byCode(indicators: readonly Indicator[], input: string): Indicator | undefined {
  const key = foldText(input).replace(/-/g, "_");
  return indicators.find((indicator) => indicator.table === key);
}

/** The indicators a search text matches: in their code or titles first, then in a value column. */
function searchIndicators(indicators: readonly Indicator[], search: string): { indicator: Indicator; matchedFields?: string[] }[] {
  const needle = searchKey(search);
  const inTitle: { indicator: Indicator }[] = [];
  const inField: { indicator: Indicator; matchedFields: string[] }[] = [];
  for (const indicator of indicators) {
    if (searchKey(`${indicator.code} ${indicator.titleShort} ${indicator.titleLong}`).includes(needle)) {
      inTitle.push({ indicator });
      continue;
    }
    const fields = indicator.fields.filter((field) => searchKey(`${field.code} ${field.title}`).includes(needle)).map((field) => field.code);
    if (fields.length > 0) inField.push({ indicator, matchedFields: fields });
  }
  return [...inTitle, ...inField];
}

/** A page of `items` from `offset`, and where the next one starts. */
function page<T>(items: readonly T[], offset: number, limit: number): { items: T[]; nextOffset?: number } {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, ...(next < items.length ? { nextOffset: next } : {}) };
}

/** The reason of an empty page: the offset is past the end of the list. */
function pastTheEnd(offset: number, what: string, total: number): string {
  return `offset ${offset} is past the end: ${what}. Start at 0, or at most ${total - 1} for the last entry.`;
}

function checkPaging(offset: number | undefined, limit: number | undefined, maxLimit: number): void {
  if (offset !== undefined) assertValid("offset", offset, (v) => (Number.isSafeInteger(v) && v >= 0 ? undefined : "Expected a non-negative integer."));
  if (limit !== undefined) assertValid("limit", limit, (v) => (Number.isSafeInteger(v) && v >= 1 && v <= maxLimit ? undefined : `Expected an integer from 1 to ${maxLimit}.`));
}

// --- findIndicators (regionalatlas-catalog) -------------------------------------------------

export interface FindIndicatorsOptions {
  /** A code, or a topic: matched in the code, the titles and the value columns. */
  search?: string | undefined;
  /** A theme (Themenbereich), or part of its title. */
  theme?: string | undefined;
  /** Only indicators offering this year. */
  year?: number | undefined;
  /** Only indicators with figures at this level in some year; with `year`, in that year. */
  level?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface FindIndicatorsResult {
  status: OperationStatus;
  total: number;
  indicators: IndicatorSummary[];
  nextOffset?: number;
  /** True when the search named one indicator by its code: it alone is the answer (empty when it fails a theme, year or level given with it). */
  exact?: boolean;
  searched?: Record<string, string | number>;
  reason?: string;
  notes?: string[];
}

const SEARCH_NOTE =
  "A search matches the code, the titles and the value columns; an indicator matched only in a value column lists them in matchedFields (turnout, Wahlbeteiligung, is a column of AI005, not an indicator).";
const NEWEST_NOTE = "The newest year a catalogue entry lists may not be loaded on the data host yet; getIndicatorMap and compareRegions fall back to the year before and say so.";

/**
 * The catalogue searched: by `search` (a code names its indicator alone; any other text is
 * matched in the code, the titles and, unlike the CLI's `indicators --search`, the value
 * columns), by `theme`, by a `year` offered and a `level` with figures. Each indicator comes with
 * its years, its levels and its field dictionary; a single one also with its levels per year.
 */
export async function findIndicators(client: RegionalatlasClient, options: FindIndicatorsOptions = {}): Promise<FindIndicatorsResult> {
  const { search, theme, year, level, offset = 0, limit = 20 } = options;
  if (search !== undefined) assertValid("search", search, textProblem);
  if (theme !== undefined) assertValid("theme", theme, textProblem);
  if (year !== undefined) assertValid("year", year, (v) => (Number.isInteger(v) ? undefined : "Expected a 4-digit year (e.g. 2020)."));
  const levelName = level === undefined ? undefined : resolveLevel(level).name;
  checkPaging(offset, limit, 100);
  const searched: Record<string, string | number> = {
    ...(search === undefined ? {} : { search }),
    ...(theme === undefined ? {} : { theme }),
    ...(year === undefined ? {} : { year }),
    ...(levelName === undefined ? {} : { level: levelName }),
  };
  const all = await client.indicators();
  const filters = { theme, year, level: levelName };
  const exact = search === undefined || tokenProblem(search.trim()) !== undefined ? undefined : byCode(all, search.trim());
  if (exact !== undefined) {
    // A code names its indicator alone, but the other filters still hold: "does AIGG-01 exist
    // per Kreis?" is answered no, with what it has, never with the indicator as if it did.
    const problem = filterProblem(exact, filters);
    if (problem !== undefined) {
      return { status: "empty", total: 0, indicators: [], exact: true, searched, reason: `${problem} Call again without that filter for what it has.` };
    }
    return { status: "ok", total: 1, indicators: [summary(exact, true)], exact: true, ...(Object.keys(searched).length > 1 ? { searched } : {}), notes: [NEWEST_NOTE] };
  }
  const kept = (search === undefined ? all.map((indicator): { indicator: Indicator; matchedFields?: string[] } => ({ indicator })) : searchIndicators(all, search)).filter(
    ({ indicator }) => filterProblem(indicator, filters) === undefined,
  );
  if (kept.length === 0) {
    const tips = [
      search === undefined ? undefined : "a word stem (bevölk, wahl, arbeitslos) or a broader topic",
      theme === undefined ? undefined : "listThemes for the theme titles",
      year === undefined ? undefined : `another year (the catalogue covers ${firstAndLast(all)})`,
      levelName === undefined ? undefined : "a coarser level",
    ].filter((tip) => tip !== undefined);
    return {
      status: "empty",
      total: 0,
      indicators: [],
      searched,
      reason:
        `None of the ${all.length} indicators of the catalogue matches.` +
        (search === undefined ? "" : " The catalogue is in German: search a German word stem, also for an English question (not population or unemployment).") +
        (tips.length > 0 ? ` Try ${tips.join("; ")}.` : ""),
    };
  }
  if (offset >= kept.length) {
    return { status: "empty", total: kept.length, indicators: [], searched: { ...searched, offset }, reason: pastTheEnd(offset, `${kept.length} indicators match`, kept.length) };
  }
  const { items, nextOffset } = page(kept, offset, limit);
  const indicators = items.map(({ indicator, matchedFields }) => ({
    ...summary(indicator, kept.length === 1),
    ...(matchedFields === undefined ? {} : { matchedFields }),
  }));
  return {
    status: "ok",
    total: kept.length,
    indicators,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(Object.keys(searched).length > 0 ? { searched } : {}),
    notes: [...(search === undefined ? [] : [SEARCH_NOTE]), NEWEST_NOTE],
  };
}

/** Why an indicator fails the theme, year or level filter (the first that fails), or undefined. */
function filterProblem(indicator: Indicator, filters: { theme?: string | undefined; year?: number | undefined; level?: string | undefined }): string | undefined {
  const { theme, year, level } = filters;
  if (theme !== undefined && !searchKey(indicator.theme).includes(searchKey(theme))) return `${indicator.code} is in the theme "${indicator.theme}", not "${theme}".`;
  if (year !== undefined && !indicator.years.includes(String(year))) return `${indicator.code} offers no year ${year}; its years: ${indicator.years.join(", ")}.`;
  if (level !== undefined && year !== undefined) {
    const published = indicator.levels[String(year)];
    if (published !== undefined && !published.includes(level)) {
      return `${indicator.code} has no figures at level ${level} in ${year}${published.length > 0 ? ` (only at ${published.join(", ")})` : " (at no level)"}; years with figures there: ${[...yearsAtLevel(indicator, level)].reverse().join(", ") || "none"}.`;
    }
  }
  if (level !== undefined && yearsAtLevel(indicator, level).length === 0) return `${indicator.code} has no figures at level ${level} in any year; it is published at ${levelsOf(indicator).join(", ") || "no level the catalogue names"}.`;
  return undefined;
}

function firstAndLast(indicators: readonly Indicator[]): string {
  const years = [...new Set(indicators.flatMap((indicator) => indicator.years))].sort();
  return `${years[0] ?? "?"}–${years[years.length - 1] ?? "?"}`;
}

// --- listThemes ------------------------------------------------------------------------------

export interface ThemeWithIndicators {
  title: string;
  indicatorCount: number;
  indicators: { code: string; titleShort: string }[];
}

/** The subject areas (Themenbereiche), each with its indicators' codes and short titles. */
export async function listThemes(client: RegionalatlasClient): Promise<{ status: OperationStatus; total: number; themes: ThemeWithIndicators[] }> {
  const [themes, indicators] = await Promise.all([client.themes(), client.indicators()]);
  return {
    status: themes.length > 0 ? "ok" : "empty",
    total: themes.length,
    themes: themes.map((theme) => ({
      title: theme.title,
      indicatorCount: theme.indicatorCount,
      indicators: indicators.filter((indicator) => indicator.theme === theme.title).map((indicator) => ({ code: indicator.code, titleShort: indicator.titleShort })),
    })),
  };
}

// --- Shared by the map and the comparison -----------------------------------------------------

/** What a query names, before the data host is asked. */
interface Target {
  indicator: Indicator;
  level: string;
  /** The years to try, in order: the one asked, or the newest with figures and the one before. */
  years: number[];
  /** True when the caller named the year. */
  yearGiven: boolean;
}

/** An answer that ends the operation before any data request: not a code, a year or level without figures. */
interface Refusal {
  status: "ambiguous" | "empty";
  reason: string;
  searched: Record<string, unknown>;
  candidates?: { code: string; titleShort: string; matchedFields?: string[] }[];
  years?: string[];
  levels?: string[];
}

/**
 * Resolve an indicator text, a level and a year against the catalogue: the indicator by its code
 * (a text that is none is answered with the indicators it matches, never taken as one), the
 * level from the fixed list, the year among those with figures at that level.
 */
async function target(client: RegionalatlasClient, input: { indicator: string; level?: string | undefined; year?: number | undefined }): Promise<Target | Refusal> {
  const text = assertValid("indicator", input.indicator, textProblem).trim();
  const level = resolveLevel(input.level ?? "land").name;
  if (input.year !== undefined) assertValid("year", input.year, (v) => (Number.isInteger(v) ? undefined : "Expected a 4-digit year (e.g. 2020)."));
  const searched = { indicator: text, level, ...(input.year === undefined ? {} : { year: input.year }) };
  const all = await client.indicators();
  const indicator = tokenProblem(text) === undefined ? byCode(all, text) : undefined;
  if (indicator === undefined) {
    const candidates = searchIndicators(all, text)
      .slice(0, 10)
      .map(({ indicator: found, matchedFields }) => ({ code: found.code, titleShort: found.titleShort, ...(matchedFields === undefined ? {} : { matchedFields }) }));
    return candidates.length > 0
      ? { status: "ambiguous", reason: `"${text}" is not an indicator code. These indicators match it: call again with one's code.`, searched, candidates }
      : { status: "empty", reason: `"${text}" is no indicator code and matches no indicator. Find the code with findIndicators.`, searched };
  }
  // A catalogue entry that lost its years, or lists none with figures, is a broken or changed
  // catalogue, not a fact about the indicator's levels.
  if (indicator.years.length === 0) {
    return { status: "empty", reason: `The catalogue lists no year for ${indicator.code}: its entry is incomplete (the catalogue may have changed). Try again later, or another indicator.`, searched, years: [] };
  }
  if (levelsOf(indicator).length === 0) {
    return { status: "empty", reason: `The catalogue publishes no figures for ${indicator.code} at any level in any year (its years: ${indicator.years.join(", ")}). Try another indicator.`, searched, years: indicator.years, levels: [] };
  }
  const atLevel = yearsAtLevel(indicator, level);
  if (input.year !== undefined) {
    const year = String(input.year);
    if (!indicator.years.includes(year)) {
      return { status: "empty", reason: `${indicator.code} offers no year ${year}.${atLevel.length > 0 ? ` Years with figures at level ${level}: ${[...atLevel].reverse().join(", ")}.` : ""}`, searched, years: indicator.years };
    }
    const published = indicator.levels[year];
    if (published !== undefined && !published.includes(level)) {
      return {
        status: "empty",
        reason:
          published.length === 0
            ? `${indicator.code} has no figures for ${year} at any level (the catalogue lists the year, but publishes none).`
            : `${indicator.code} has no figures at level ${level} in ${year}; it is published there only at ${published.join(", ")}. Call again with one of those levels.`,
        searched,
        levels: published,
        years: [...atLevel].reverse(),
      };
    }
    return { indicator, level, years: [input.year], yearGiven: true };
  }
  if (atLevel.length === 0) {
    return { status: "empty", reason: `${indicator.code} has no figures at level ${level} in any year; it is published at ${levelsOf(indicator).join(", ")}. Call again with one of those levels.`, searched, levels: levelsOf(indicator) };
  }
  return { indicator, level, years: atLevel.slice(0, 2).map(Number), yearGiven: false };
}

/** The note on an indicator whose catalogue entry lists no value columns. */
const NO_COLUMNS = (code: string): string =>
  `The catalogue names no value columns for ${code} (its entry is incomplete): nothing says what each column measures; never infer it from a code.`;

/** The rows of a target, the year they are of, and the notes on how it was chosen. */
interface Fetched {
  rows: RegionRow[];
  year: number;
  notes: string[];
  incomplete: boolean;
}

/**
 * Each region once, as first sent, and the keys sent more than once: a region twice in a level
 * counted 17 Länder, and its name and key were ambiguous with no way to resolve them.
 */
function onceEach(rows: readonly RegionRow[]): { rows: RegionRow[]; twice: string[] } {
  const seen = new Set<string>();
  const twice = new Set<string>();
  const kept: RegionRow[] = [];
  for (const row of rows) {
    if (seen.has(row.ags)) twice.add(row.ags);
    else {
      seen.add(row.ags);
      kept.push(row);
    }
  }
  return { rows: kept, twice: [...twice] };
}

/**
 * Whether rows carry anything of the indicator: a figure, or a special value the upstream sent.
 * Rows of the boundary table alone (every value null without a reason) are what the data host's
 * LEFT OUTER JOIN answers for a year the boundary table has and the indicator's table hasn't.
 */
function anyFigure(rows: readonly RegionRow[]): boolean {
  return rows.some(
    (row) => Object.values(row.values).some((value) => value !== null) || Object.values(row.missing ?? {}).some((reason) => reason !== UNPUBLISHED_REASON),
  );
}

/**
 * The level's rows for the target's year. A year the caller left out is the newest with figures
 * at the level; when the data host has no figures for it yet (no rows, or rows without a value:
 * the catalogue lists years before they are loaded), the year before, with a note.
 */
async function fetchRows(client: RegionalatlasClient, t: Target): Promise<Fetched | undefined> {
  const notes: string[] = [];
  for (const year of t.years) {
    const result = await client.queryResult({ indicator: t.indicator.code, level: t.level, year });
    if (result.fetched > 0 && anyFigure(result.rows)) {
      if (result.exceededTransferLimit) notes.push(`The data host stopped at its record limit after ${result.fetched} rows: the level is incomplete. Use a coarser level.`);
      const { rows, twice } = onceEach(result.rows);
      if (twice.length > 0) {
        notes.push(`The data host sent ${twice.length} region${twice.length > 1 ? "s" : ""} twice (${twice.slice(0, 5).join(", ")}${twice.length > 5 ? ", …" : ""}): each is shown once, as first sent.`);
      }
      return { rows: firstYearChangeRates(t.indicator, year, rows), year, notes, incomplete: result.exceededTransferLimit };
    }
    if (!t.yearGiven) {
      notes.push(`${year} is the newest year with figures at level ${t.level} in the catalogue, but the data host has ${result.fetched > 0 ? "no figures" : "no rows"} for it yet.`);
    }
  }
  return undefined;
}

/** "nichts vorhanden" (2222222222), the upstream's zero, as a change rate in an indicator's first year: no previous year. */
const NOTHING = "nichts vorhanden";

/**
 * In an indicator's first year a Veränderungsrate column (`<field>v`) has no previous year to
 * compare with; the upstream writes "nichts vorhanden" there, which the client reads as 0. Here it
 * is null, with that reason: a change of 0 would be a figure nobody measured.
 */
function firstYearChangeRates(indicator: Indicator, year: number, rows: RegionRow[]): RegionRow[] {
  if (String(year) !== indicator.years[0]) return rows;
  return rows.map((row) => {
    const missing = row.missing;
    if (missing === undefined) return row;
    const changed = Object.keys(missing).filter((key) => /v$/.test(key) && missing[key] === NOTHING);
    if (changed.length === 0) return row;
    const values = { ...row.values };
    const reasons = { ...missing };
    for (const key of changed) {
      values[key] = null;
      reasons[key] = "no previous year (the indicator's first year): no change rate";
    }
    return { ...row, values, missing: reasons };
  });
}

/** Rows of one level by key length (2 Land, 3 Regierungsbezirk, 5 Kreis, 8 Gemeinde), when they differ. */
function fillNote(rows: readonly RegionRow[], level: string): string | undefined {
  const lengths = new Map<number, number>();
  for (const row of rows) lengths.set(row.ags.length, (lengths.get(row.ags.length) ?? 0) + 1);
  if (lengths.size < 2) return undefined;
  const parts = [...lengths].sort((a, b) => a[0] - b[0]).map(([length, count]) => `${count} with a ${length}-digit key`);
  return `Level ${level} fills in with coarser units where a finer one does not exist (${parts.join(", ")}): the rows still cover Germany once, but not all are ${level} units.`;
}

/** The value columns of a row's keys that the dictionary names, in its order; then any it doesn't. */
function dictionaryFor(indicator: Indicator, keys: readonly string[]): IndicatorField[] {
  const wanted = new Set(keys.map(fieldKey));
  const known = indicator.fields.filter((field) => wanted.has(field.code));
  const unknown = [...wanted].filter((key) => !known.some((field) => field.code === key)).map((code) => ({ code, title: "", unit: "" }));
  return [...known, ...unknown];
}

// --- getIndicatorMap (regionalatlas-map) ----------------------------------------------------

export interface IndicatorMapOptions {
  /** The indicator's code (AI002-1-5) or table form (ai002_1_5). */
  indicator: string;
  /** land (default), regierungsbezirk, kreis or gemeinde. */
  level?: string | undefined;
  /** The year; default the newest with figures at the level (the year before when it isn't loaded yet). */
  year?: number | undefined;
  /** Only these value columns. */
  fields?: string[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface MapRow {
  ags: string;
  name: string;
  values: Record<string, number | null>;
  missing?: Record<string, string>;
}

export interface IndicatorMapResult {
  status: OperationStatus;
  indicator?: { code: string; titleShort: string; theme: string };
  level?: string;
  year?: number;
  /** What each `values` key measures, and its unit. */
  fields?: IndicatorField[];
  /** Rows of the whole level (before paging). */
  total?: number;
  rows?: MapRow[];
  nextOffset?: number;
  /** Per value column: rows with a figure, without one, and the special values met. */
  coverage?: Record<string, { withFigure: number; withoutFigure: number; special?: Record<string, number> }>;
  incomplete?: boolean;
  notes?: string[];
  searched?: Record<string, unknown>;
  reason?: string;
  candidates?: unknown[];
  years?: string[];
  levels?: string[];
}

/** One indicator for every region of a level and year (the data behind a choropleth map). */
export async function getIndicatorMap(client: RegionalatlasClient, options: IndicatorMapOptions): Promise<IndicatorMapResult> {
  const { offset = 0, limit = 100 } = options;
  checkPaging(offset, limit, 1000);
  if (options.fields !== undefined) {
    assertValid("fields", options.fields, (v) => (Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === "string" && tokenProblem(f) === undefined) ? undefined : "Expected one or more value column codes (ai0201)."));
  }
  const t = await target(client, options);
  if (!("indicator" in t)) return t;
  const { indicator } = t;
  if (options.fields !== undefined) {
    const unknown = options.fields.filter((field) => indicator.fields.length > 0 && findField(indicator, field) === undefined);
    if (unknown.length > 0) {
      return {
        status: "empty",
        reason: `${indicator.code} has no value column ${unknown.map((f) => `"${f}"`).join(", ")}. Its columns are in fields.`,
        searched: { indicator: indicator.code, fields: options.fields },
        fields: indicator.fields,
      };
    }
  }
  const fetched = await fetchRows(client, t);
  const head = { indicator: { code: indicator.code, titleShort: indicator.titleShort, theme: indicator.theme }, level: t.level };
  if (fetched === undefined) {
    return {
      status: "empty",
      ...head,
      searched: { indicator: indicator.code, level: t.level, ...(t.yearGiven ? { year: t.years[0] } : {}) },
      reason: t.yearGiven
        ? `The data host has no rows (or no figures) for ${indicator.code} at level ${t.level} in ${t.years[0]}, though the catalogue lists the year (not loaded yet, or withdrawn). Try an earlier year.`
        : `The data host has no rows (or no figures) for ${indicator.code} at level ${t.level} in ${t.years.join(" or ")}, the newest catalogue years with figures there. Name an earlier year.`,
      years: indicator.years,
    };
  }
  const wanted = options.fields === undefined ? undefined : new Set(options.fields.map(fieldKey));
  // A value column the catalogue doesn't name has no title or unit: nothing says what it
  // measures, and a model must not guess it from the code. When the catalogue names the
  // indicator's columns, the others are left out (a note names them): a drifted answer with a
  // thousand such columns would otherwise fill the whole result.
  const named = indicator.fields.length === 0 ? undefined : new Set(indicator.fields.map((field) => field.code));
  const unnamed = new Set<string>();
  const rows: MapRow[] = [...fetched.rows]
    .sort((a, b) => (a.ags < b.ags ? -1 : a.ags > b.ags ? 1 : 0))
    .map((row) => {
      const values: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(row.values)) {
        if (named !== undefined && !named.has(fieldKey(key))) {
          unnamed.add(key);
          continue;
        }
        if (wanted === undefined || wanted.has(fieldKey(key))) values[key] = value;
      }
      const missing = Object.entries(row.missing ?? {}).filter(([key]) => key in values);
      return { ags: row.ags, name: row.name, values, ...(missing.length > 0 ? { missing: Object.fromEntries(missing) } : {}) };
    });
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
  const coverage: NonNullable<IndicatorMapResult["coverage"]> = {};
  for (const key of keys) {
    const withFigure = rows.filter((row) => row.values[key] !== null && row.values[key] !== undefined).length;
    const special: Record<string, number> = {};
    for (const row of rows) {
      const reason = row.missing?.[key];
      if (reason !== undefined) special[reason] = (special[reason] ?? 0) + 1;
    }
    coverage[key] = { withFigure, withoutFigure: rows.length - withFigure, ...(Object.keys(special).length > 0 ? { special } : {}) };
  }
  const notes = [...fetched.notes];
  if (!t.yearGiven && fetched.year !== t.years[0]) notes.push(`These are the figures of ${fetched.year}: say which year the map shows.`);
  const fill = fillNote(fetched.rows, t.level);
  if (fill !== undefined) notes.push(fill);
  if (indicator.fields.length === 0) notes.push(NO_COLUMNS(indicator.code));
  if (unnamed.size > 0) {
    const shown = [...unnamed].slice(0, 5).map((key) => cutText(key, 40));
    notes.push(`The data host sent ${unnamed.size} value column${unnamed.size > 1 ? "s" : ""} the catalogue doesn't name (${shown.join(", ")}${unnamed.size > 5 ? ", …" : ""}): left out, since nothing says what they measure.`);
  }
  const unpublished = keys.filter((key) => columnPublished(indicator, key, t.level, fetched.year) === false);
  if (unpublished.length > 0) {
    notes.push(`The catalogue lists ${unpublished.join(", ")} for ${fetched.year} but publishes no figure for ${unpublished.length > 1 ? "them" : "it"} at level ${t.level}: no figure (null), not 0.`);
  }
  if (Object.values(coverage).some((c) => c.special?.[NOTHING] !== undefined)) {
    notes.push('A 0 with missing "nichts vorhanden" is the table symbol "-": exactly zero, a figure on the scale, not "no data".');
  }
  const { items, nextOffset } = page(rows, offset, limit);
  const past = rows.length > 0 && offset >= rows.length;
  return {
    status: rows.length > 0 && !past ? "ok" : "empty",
    ...(past ? { reason: pastTheEnd(offset, `the level has ${rows.length} regions`, rows.length) } : {}),
    ...head,
    year: fetched.year,
    fields: dictionaryFor(indicator, keys),
    total: rows.length,
    rows: items,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    coverage,
    ...(fetched.incomplete ? { incomplete: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// --- compareRegions (regionalatlas-compare) --------------------------------------------------

export interface CompareRegionsOptions {
  indicator: string;
  /** The value column to compare on; required when the indicator has several. */
  field?: string | undefined;
  level?: string | undefined;
  year?: number | undefined;
  /** Regions by AGS or name (1-20); none: the highest and lowest of the level. */
  regions?: string[] | undefined;
  /** Without regions: how many of the highest and the lowest (default 5). */
  top?: number | undefined;
}

export interface ComparedRegion {
  /** What the caller named (absent for a region of the top list). */
  asked?: string;
  ags: string;
  name: string;
  /** The long name with the kind ("Offenbach, Landkreis"), where it differs from name. */
  longName?: string;
  value: number | null;
  /** Why there is no figure, or that a 0 is the upstream's "nichts vorhanden". */
  missing?: string;
  /** 1 for the highest of the level's regions with a figure; ties share a rank. */
  rank?: number;
  /** The value minus the level's mean. */
  vsMean?: number;
  /** How the region was found: ags, ags-filled (a longer key), name. */
  matchedBy?: string;
  /** Regions whose name only contains the one asked (left out: the name matched exactly). */
  alsoNamed?: { ags: string; name: string; longName?: string }[];
}

export interface CompareRegionsResult {
  status: OperationStatus;
  indicator?: { code: string; titleShort: string; theme: string };
  field?: IndicatorField;
  level?: string;
  year?: number;
  /** The whole level: regions with and without a figure, mean, median, lowest, highest. */
  levelStats?: { regions: number; withFigure: number; withoutFigure: number; mean?: number; median?: number; lowest?: ComparedRegion; highest?: ComparedRegion };
  /** The named regions found, highest first (no figure last). */
  regions?: ComparedRegion[];
  /** Named regions that matched several rows: which one is meant? */
  ambiguousRegions?: { asked: string; reason: string; candidates: { ags: string; name: string; longName?: string }[] }[];
  /** Named regions with no row at this level. */
  notFound?: { asked: string; reason: string }[];
  highest?: ComparedRegion[];
  lowest?: ComparedRegion[];
  notes?: string[];
  searched?: Record<string, unknown>;
  reason?: string;
  candidates?: unknown[];
  years?: string[];
  levels?: string[];
}

/** A region as a candidate or an alsoNamed entry: key, name, and the long name where it differs. */
function short(row: RegionRow): { ags: string; name: string; longName?: string } {
  return { ags: row.ags, name: row.name, ...(row.longName === undefined ? {} : { longName: row.longName }) };
}

/** Whether a row's long name says it is a Landkreis or Kreis ("kreis"), or a city ("stadt"). */
function isKind(row: RegionRow, kind: "kreis" | "stadt"): boolean {
  const long = row.longName ?? row.name;
  const comma = long.lastIndexOf(",");
  if (comma < 0) return false;
  const suffix = foldText(long.slice(comma + 1));
  return kind === "stadt" ? suffix.includes("stadt") : suffix.includes("kreis") && !suffix.includes("kreisfrei");
}

/** The decimals a figure is written with (`84.3` has 1). */
function decimalsOf(value: number): number {
  const text = String(value);
  return /e/i.test(text) ? 4 : (text.split(".")[1]?.length ?? 0);
}

/** `value` rounded to `decimals` places. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * One value column for a few named regions, ranked against the whole level, or the highest and
 * lowest of the level. The level is fetched once; regions are matched in its rows (an AGS, an
 * exact name, else a part of a name). A name several rows share or contain is reported with its
 * candidates, never resolved to the first.
 */
export async function compareRegions(client: RegionalatlasClient, options: CompareRegionsOptions): Promise<CompareRegionsResult> {
  const { regions, top = 5 } = options;
  if (regions !== undefined) {
    assertValid("regions", regions, (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((r) => typeof r === "string" && textProblem(r) === undefined) ? undefined : "Expected 1 to 20 region names or keys."));
  }
  assertValid("top", top, (v) => (Number.isSafeInteger(v) && v >= 1 && v <= 50 ? undefined : "Expected an integer from 1 to 50."));
  if (options.field !== undefined) assertValid("field", options.field, tokenProblem);
  const t = await target(client, options);
  if (!("indicator" in t)) return t;
  const { indicator } = t;
  const head = { indicator: { code: indicator.code, titleShort: indicator.titleShort, theme: indicator.theme }, level: t.level };
  let field: IndicatorField | undefined;
  if (options.field !== undefined) {
    field = indicator.fields.length === 0 ? { code: fieldKey(options.field), title: "", unit: "" } : findField(indicator, options.field);
    if (field === undefined) {
      return { status: "empty", ...head, reason: `${indicator.code} has no value column "${options.field}". Pick one of candidates.`, searched: { indicator: indicator.code, field: options.field }, candidates: indicator.fields };
    }
  } else if (indicator.fields.length === 1) {
    field = indicator.fields[0];
  } else {
    return {
      status: "ambiguous",
      ...head,
      reason: indicator.fields.length === 0 ? `${NO_COLUMNS(indicator.code)} Pass field only with a code the user named.` : `${indicator.code} has ${indicator.fields.length} value columns: ask which one is meant and call again with its code as field.`,
      searched: { indicator: indicator.code },
      candidates: indicator.fields,
    };
  }
  const key = (field as IndicatorField).code;
  const fetched = await fetchRows(client, t);
  if (fetched === undefined) {
    return {
      status: "empty",
      ...head,
      field,
      searched: { indicator: indicator.code, level: t.level, ...(t.yearGiven ? { year: t.years[0] } : {}) },
      reason: `The data host has no rows (or no figures) for ${indicator.code} at level ${t.level} in ${t.years.join(" or ")}. Name an earlier year.`,
      years: indicator.years,
    };
  }
  if (columnPublished(indicator, key, t.level, fetched.year) === false) {
    const withFigures = indicator.years.filter((y) => columnPublished(indicator, key, t.level, y) === true);
    return {
      status: "empty",
      ...head,
      field,
      year: fetched.year,
      searched: { indicator: indicator.code, field: key, level: t.level, ...(t.yearGiven ? { year: t.years[0] } : {}) },
      reason:
        `The catalogue publishes no figure for ${key} in ${fetched.year} at level ${t.level}: the column is listed, but empty that year (the data host's 0s there are no figures).` +
        (withFigures.length > 0 ? ` Years with figures for it at this level: ${withFigures.join(", ")}.` : ""),
      years: withFigures,
    };
  }
  const valueOf = (row: RegionRow): number | null => {
    const entry = Object.entries(row.values).find(([k]) => fieldKey(k) === key);
    return entry === undefined ? null : entry[1];
  };
  const reasonOf = (row: RegionRow): string | undefined => Object.entries(row.missing ?? {}).find(([k]) => fieldKey(k) === key)?.[1];
  const withFigure = fetched.rows.filter((row) => valueOf(row) !== null);
  const sorted = [...withFigure].sort((a, b) => (valueOf(b) as number) - (valueOf(a) as number));
  const values = sorted.map((row) => valueOf(row) as number);
  const mean = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : undefined;
  const median = values.length === 0 ? undefined : values.length % 2 === 1 ? values[(values.length - 1) / 2] : ((values[values.length / 2 - 1] as number) + (values[values.length / 2] as number)) / 2;
  const rankOf = (value: number): number => values.findIndex((v) => v === value) + 1;
  // A mean or a difference is given to one decimal more than the figures carry (at most four):
  // 81.56 next to figures of 84.3, not 81.5563.
  const decimals = Math.min(4, values.reduce((most, v) => Math.max(most, decimalsOf(v)), 0) + 1);
  const round = (value: number): number => roundTo(value, decimals);
  const describe = (row: RegionRow, extra: Partial<ComparedRegion> = {}): ComparedRegion => {
    const value = valueOf(row);
    const reason = reasonOf(row);
    return {
      ...extra,
      ags: row.ags,
      name: row.name,
      ...(row.longName === undefined ? {} : { longName: row.longName }),
      value,
      ...(reason === undefined ? {} : { missing: reason }),
      ...(value === null ? {} : { rank: rankOf(value), ...(mean === undefined ? {} : { vsMean: round(value - mean) }) }),
    };
  };
  const levelStats: NonNullable<CompareRegionsResult["levelStats"]> = {
    regions: fetched.rows.length,
    withFigure: withFigure.length,
    withoutFigure: fetched.rows.length - withFigure.length,
    ...(mean === undefined ? {} : { mean: round(mean), median: round(median as number) }),
    ...(sorted.length > 0 ? { highest: describe(sorted[0] as RegionRow), lowest: describe(sorted[sorted.length - 1] as RegionRow) } : {}),
  };
  const notes = [...fetched.notes];
  if (!t.yearGiven && fetched.year !== t.years[0]) notes.push(`These are the figures of ${fetched.year}: say which year is compared.`);
  const fill = fillNote(fetched.rows, t.level);
  if (fill !== undefined) notes.push(fill);
  if (fetched.rows.some((row) => reasonOf(row) === NOTHING)) notes.push('A 0 with missing "nichts vorhanden" is the table symbol "-": exactly zero, ranked as 0.');
  if (levelStats.withoutFigure > 0) notes.push(`${levelStats.withoutFigure} of ${fetched.rows.length} regions have no figure: left out of ranks, mean and median.`);
  const base = { ...head, field, year: fetched.year, levelStats };
  if (regions === undefined) {
    return {
      status: withFigure.length > 0 ? "ok" : "empty",
      ...base,
      highest: sorted.slice(0, top).map((row) => describe(row)),
      lowest: sorted.slice(-top).reverse().map((row) => describe(row)),
      ...(withFigure.length > 0 ? {} : { reason: `No region at level ${t.level} has a figure for ${key} in ${fetched.year}.` }),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
  const found: ComparedRegion[] = [];
  const ambiguous: NonNullable<CompareRegionsResult["ambiguousRegions"]> = [];
  const notFound: NonNullable<CompareRegionsResult["notFound"]> = [];
  for (const asked of regions) {
    const match = matchRegion(fetched.rows, asked);
    if (match.rows.length === 0) {
      notFound.push({
        asked,
        reason: /^\d+$/.test(asked.trim())
          ? `No region at level ${t.level} has this key (${fetched.rows.length} regions). All regions compared must be of one level: a Land at land, a Kreis or kreisfreie Stadt at kreis, a Gemeinde at gemeinde.`
          : `No region at level ${t.level} has this name (${fetched.rows.length} regions). The data names a Landkreis "X, Landkreis" or X alone, a kreisfreie Stadt by its name ("Kassel"); "Landkreis X" and "Stadt X" are understood, umlauts may be spelled out. Check the spelling, or the level: a Land is at land, a Kreis or kreisfreie Stadt at kreis, a Gemeinde at gemeinde.`,
      });
      continue;
    }
    if (match.rows.length > 1) {
      ambiguous.push({
        asked,
        reason:
          match.by === "name"
            ? `${match.rows.length} regions share this name.`
            : match.by === "substring"
              ? `No region is named exactly this; ${match.rows.length} contain it.`
              : match.by === "name-form"
                ? `${match.rows.length} regions fit this name and kind.`
                : `${match.rows.length} regions have this key.`,
        candidates: match.rows.slice(0, 20).map(short),
      });
      continue;
    }
    const row = match.rows[0] as RegionRow;
    // The exact name of a Landkreis whose short name doesn't say so ("Offenbach", long name
    // "Offenbach, Landkreis") while a city's name contains it ("Offenbach am Main"): a user who
    // says "Offenbach" likely means the city, the data's exact name is the Landkreis. Ask.
    const cities = match.by === "name" && isKind(row, "kreis") ? match.others.filter((other) => isKind(other, "stadt")) : [];
    if (cities.length > 0) {
      ambiguous.push({
        asked,
        reason: `The exact name is the Landkreis or Kreis ${row.longName ?? row.name}; ${cities.length > 1 ? "cities' names contain" : "a city's name contains"} it (${cities.map((c) => c.longName ?? c.name).join("; ")}). Ask which one is meant.`,
        candidates: [row, ...cities].slice(0, 20).map(short),
      });
      continue;
    }
    if (found.some((r) => r.ags === row.ags)) continue;
    found.push(
      describe(row, {
        asked,
        matchedBy: match.by,
        ...(match.others.length > 0 ? { alsoNamed: match.others.slice(0, 10).map(short) } : {}),
      }),
    );
  }
  found.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : b.value - a.value));
  if (found.some((r) => r.alsoNamed !== undefined)) notes.push("A region matched by its exact name lists in alsoNamed the regions whose name only contains it (München, Landkreis next to München): say which one is shown.");
  const status: OperationStatus = ambiguous.length > 0 ? "ambiguous" : found.length > 0 ? "ok" : "empty";
  return {
    status,
    ...base,
    regions: found,
    ...(ambiguous.length > 0 ? { ambiguousRegions: ambiguous } : {}),
    ...(notFound.length > 0 ? { notFound } : {}),
    ...(status === "ambiguous" ? { reason: "Some regions match several rows: ask which one is meant and call again with its AGS." } : {}),
    ...(status === "empty" ? { reason: "None of the regions is at this level.", searched: { indicator: indicator.code, level: t.level, regions } } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
