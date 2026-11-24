// The use cases (operations.ts) against a mock of both hosts (recorded.ts: answers recorded on
// 2026-11-20), with the skills' traps as cases: a column topic (Wahlbeteiligung) found in the
// value columns, not only in the titles; a text that is no code answered with candidates, never
// taken as one; a level or year without figures answered before any data request; the newest
// catalogue year not loaded yet (the year before, with a note); the field dictionary with every
// map; "nichts vorhanden" exactly 0, but no change rate in the indicator's first year; regions
// matched by key, exact name or part of one, and a name several regions share or contain
// reported, never resolved to the first; a level that fills in with coarser units said so. And the
// SQL guard: only the catalogue's table, the level's typ and a catalogue year reach the data host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RegionalatlasClient } from "../src/client.js";
import { RegionalatlasValidationError } from "../src/errors.js";
import { compareRegions, findIndicators, getIndicatorMap, listThemes, searchKey } from "../src/operations.js";
import { CARS_LAND_2025, ELECTION_LAND_2025, POPULATION_KREIS_2024, RECORDED_CATALOG, regionalatlasApi, sqlOf, type RecordedOverrides } from "./recorded.js";

function api(overrides: RecordedOverrides = {}) {
  const mock = regionalatlasApi(overrides);
  return { mock, client: new RegionalatlasClient({ transport: mock.transport }) };
}

/** The data requests a mock got (the catalogue's are not). */
const dataRequests = (mock: ReturnType<typeof regionalatlasApi>) => mock.calls.filter((call) => call.url.includes("/dynamicLayer/query"));

// --- findIndicators ---

test("findIndicators: a code names its indicator alone, with its levels per year and its field dictionary", async () => {
  const { client } = api();
  const result = await findIndicators(client, { search: "ai005" });
  assert.equal(result.status, "ok");
  assert.equal(result.exact, true);
  assert.equal(result.indicators.length, 1);
  const [ai005] = result.indicators;
  assert.equal(ai005?.code, "AI005");
  assert.deepEqual(ai005?.years, ["1998", "2002", "2005", "2009", "2013", "2017", "2021", "2025"]);
  assert.deepEqual(ai005?.levelsByYear?.["2025"], ["land", "regierungsbezirk", "kreis"]);
  assert.deepEqual(ai005?.levels, ["land", "regierungsbezirk", "kreis"]);
  assert.deepEqual(ai005?.fields.find((f) => f.code === "ai0506"), { code: "ai0506", title: "Wahlbeteiligung, Bundestagswahl", unit: "Prozent" });
  assert.deepEqual(ai005?.fields.find((f) => f.code === "ai0507")?.title, "Zweitstimmenanteil AfD, Bundestagswahl");
});

test("findIndicators: a column topic (Wahlbeteiligung) is found in the value columns, where the CLI's title search finds nothing", async () => {
  const { client } = api();
  assert.deepEqual(await client.indicators({ search: "wahlbeteiligung" }), [], "the titles don't name it");
  const result = await findIndicators(client, { search: "Wahlbeteiligung" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.indicators.map((i) => [i.code, i.matchedFields]), [["AI005", ["ai0506"]]]);
});

test("findIndicators: umlauts may be spelled out (Bevoelkerung), and title matches come before column matches", async () => {
  const { client } = api();
  assert.equal(searchKey("Bevölkerung"), searchKey("BEVOELKERUNG"));
  const result = await findIndicators(client, { search: "Bevoelkerung" });
  assert.deepEqual(result.indicators.map((i) => i.code), ["AI002-1-5", "AI-Z1-2011"]);
  assert.equal(result.indicators[0]?.matchedFields, undefined);
  const columns = await findIndicators(client, { search: "Gesamtbevoelkerung" });
  assert.deepEqual(
    columns.indicators.map((i) => [i.code, i.matchedFields]),
    [["AI002-1-5", ["ai0208", "ai0208v"]], ["AI-Z1-2011", ["ai_z01", "ai_z04"]]],
    "only columns name it; Zensus' codes as the data host writes them (AI-Z01 is ai_z01)",
  );
});

test("findIndicators: theme, year and level filter; a level counts when some year has figures there", async () => {
  const { client } = api();
  assert.deepEqual((await findIndicators(client, { theme: "gesundheit" })).indicators.map((i) => i.code), ["AIGG-01"]);
  assert.deepEqual((await findIndicators(client, { year: 2026 })).indicators.map((i) => i.code), ["AI013-1"]);
  assert.deepEqual((await findIndicators(client, { level: "gemeinde" })).indicators.map((i) => i.code), ["AI002-1-5"]);
  assert.deepEqual((await findIndicators(client, { theme: "Gesundheit", level: "kreis" })).status, "empty");
  const levels = (await findIndicators(client, { search: "AIGG-01" })).indicators[0]?.levels;
  assert.deepEqual(levels, ["land"], "AIGG-01 is published per Land only");
});

test("findIndicators: a code with a theme, year or level is checked against them, never answered as if they held", async () => {
  const { client } = api();
  const kreis = await findIndicators(client, { search: "AIGG-01", level: "kreis" });
  assert.equal(kreis.status, "empty");
  assert.deepEqual(kreis.indicators, []);
  assert.match(kreis.reason ?? "", /AIGG-01 .*no figures at level kreis.*land/);
  const year = await findIndicators(client, { search: "AI005", year: 2024 });
  assert.equal(year.status, "empty");
  assert.match(year.reason ?? "", /AI005 offers no year 2024.*2021, 2025/);
  const theme = await findIndicators(client, { search: "AI005", theme: "Umwelt" });
  assert.equal(theme.status, "empty");
  assert.match(theme.reason ?? "", /AI005 is in the theme "Wahlen", not "Umwelt"/);
  const fits = await findIndicators(client, { search: "AI005", theme: "Wahl", year: 2025, level: "kreis" });
  assert.equal(fits.status, "ok");
  assert.equal(fits.exact, true);
  assert.deepEqual(fits.searched, { search: "AI005", theme: "Wahl", year: 2025, level: "kreis" });
});

test("findIndicators: year and level together mean figures at that level in that year", async () => {
  const { client } = api();
  const in2000 = await findIndicators(client, { year: 2000, level: "gemeinde" });
  assert.equal(in2000.status, "empty", "AI002-1-5 offers 2000 and has Gemeinde figures, but not in 2000");
  assert.deepEqual((await findIndicators(client, { year: 2024, level: "gemeinde" })).indicators.map((i) => i.code), ["AI002-1-5"]);
  const code = await findIndicators(client, { search: "AI002-1-5", year: 2000, level: "gemeinde" });
  assert.equal(code.status, "empty");
  assert.match(code.reason ?? "", /no figures at level gemeinde in 2000/);
});

test("findIndicators: nothing found is empty with what was searched and what to try", async () => {
  const { client } = api();
  const result = await findIndicators(client, { search: "Fischerei", year: 2024 });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.searched, { search: "Fischerei", year: 2024 });
  assert.match(result.reason ?? "", /None of the 5 indicators/);
  assert.match(result.reason ?? "", /word stem/);
  const english = await findIndicators(client, { search: "population density" });
  assert.equal(english.status, "empty");
  assert.match(english.reason ?? "", /catalogue is in German: search a German word stem, also for an English question/);
});

test("findIndicators: a year listed without figures at any level is named in emptyYears", async () => {
  const catalog = structuredClone(RECORDED_CATALOG) as { children: { code: string; years: Record<string, unknown> }[] }[];
  const ai013 = catalog.flatMap((t) => t.children).find((c) => c.code === "AI013-1");
  if (ai013 === undefined) throw new Error("fixture");
  ai013.years["2006"] = [{ geom_levels: [0, 0, 0, 0] }];
  const { client } = api({ catalog });
  const [summary] = (await findIndicators(client, { search: "AI013-1" })).indicators;
  assert.deepEqual(summary?.emptyYears, ["2006"]);
});

test("findIndicators: pages with offset and limit; the whole catalogue without a filter", async () => {
  const { client } = api();
  const first = await findIndicators(client, { limit: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.indicators.length, 2);
  assert.equal(first.nextOffset, 2);
  const last = await findIndicators(client, { offset: 4, limit: 2 });
  assert.equal(last.indicators.length, 1);
  assert.equal(last.nextOffset, undefined);
  await assert.rejects(findIndicators(client, { search: " " }), RegionalatlasValidationError);
  await assert.rejects(findIndicators(client, { level: "bezirk" }), RegionalatlasValidationError);
});

test("an offset past the end is empty with a reason naming the total, in findIndicators and getIndicatorMap", async () => {
  const { client } = api();
  const found = await findIndicators(client, { offset: 500 });
  assert.equal(found.status, "empty");
  assert.equal(found.total, 5);
  assert.deepEqual(found.indicators, []);
  assert.match(found.reason ?? "", /offset 500 is past the end: 5 indicators match/);
  const map = await getIndicatorMap(client, { indicator: "AI005", year: 2025, offset: 16 });
  assert.equal(map.status, "empty");
  assert.equal(map.total, 16);
  assert.deepEqual(map.rows, []);
  assert.match(map.reason ?? "", /offset 16 is past the end: the level has 16 regions/);
});

// --- listThemes ---

test("listThemes: each theme with its count and its indicators", async () => {
  const { client } = api();
  const result = await listThemes(client);
  assert.equal(result.total, 5);
  assert.deepEqual(result.themes.find((t) => t.title === "Wahlen"), { title: "Wahlen", indicatorCount: 1, indicators: [{ code: "AI005", titleShort: "Bundestagswahl" }] });
});

// --- getIndicatorMap ---

test("getIndicatorMap: every Land with the values and what each column measures, in the catalogue's order", async () => {
  const { client, mock } = api();
  const result = await getIndicatorMap(client, { indicator: "AI005", year: 2025 });
  assert.equal(result.status, "ok");
  assert.equal(result.total, 16);
  assert.equal(result.year, 2025);
  assert.deepEqual(result.fields?.map((f) => f.code), ["ai0501", "ai0502", "ai0503", "ai0504", "ai0505", "ai0507", "ai0506"]);
  assert.deepEqual(result.rows?.[0], { ags: "01", name: "Schleswig-Holstein", values: { ai0501: 27.6, ai0502: 18.8, ai0503: 4.7, ai0504: 14.9, ai0505: 7.8, ai0507: 16.3, ai0506: 83.5 } });
  assert.deepEqual(result.coverage?.["ai0506"], { withFigure: 16, withoutFigure: 0 });
  assert.equal(dataRequests(mock).length, 1);
});

test("getIndicatorMap: the newest catalogue year not loaded yet: the year before, with a note saying so", async () => {
  const { client, mock } = api();
  const result = await getIndicatorMap(client, { indicator: "AI013-1" });
  assert.equal(result.status, "ok");
  assert.equal(result.year, 2025);
  assert.equal(result.total, 16);
  assert.ok(result.notes?.some((n) => n.includes("2026 is the newest year") && n.includes("no rows for it yet")), result.notes?.join("\n"));
  assert.ok(result.notes?.some((n) => n.includes("figures of 2025")));
  assert.deepEqual(dataRequests(mock).map((r) => sqlOf(r)?.year), [2026, 2025]);
});

test("getIndicatorMap: a year the caller names is never replaced: no rows is empty with the reason", async () => {
  const { client, mock } = api();
  const result = await getIndicatorMap(client, { indicator: "AI013-1", year: 2026 });
  assert.equal(result.status, "empty");
  assert.match(result.reason ?? "", /no rows \(or no figures\) for AI013-1 at level land in 2026/);
  assert.equal(dataRequests(mock).length, 1);
});

test("getIndicatorMap: a level or a year without figures is answered from the catalogue, before any data request", async () => {
  const { client, mock } = api();
  const level = await getIndicatorMap(client, { indicator: "AIGG-01", level: "kreis" });
  assert.equal(level.status, "empty");
  assert.deepEqual(level.levels, ["land"]);
  assert.match(level.reason ?? "", /published at land/);
  const year = await getIndicatorMap(client, { indicator: "AI005", year: 2024 });
  assert.equal(year.status, "empty");
  assert.match(year.reason ?? "", /offers no year 2024/);
  assert.deepEqual(year.years, ["1998", "2002", "2005", "2009", "2013", "2017", "2021", "2025"]);
  const field = await getIndicatorMap(client, { indicator: "AI005", fields: ["ai0599"] });
  assert.equal(field.status, "empty");
  assert.equal(field.fields?.length, 7);
  assert.equal(dataRequests(mock).length, 0);
});

test("getIndicatorMap: a text that is no code is answered with the indicators it matches, never taken as one", async () => {
  const { client, mock } = api();
  const result = await getIndicatorMap(client, { indicator: "Bundestagswahl" });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates, [{ code: "AI005", titleShort: "Bundestagswahl" }]);
  const none = await getIndicatorMap(client, { indicator: "Fischerei" });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /findIndicators/);
  assert.equal(dataRequests(mock).length, 0);
});

test("getIndicatorMap: fields project the values; a level that fills in with coarser units says so; rows page", async () => {
  const { client } = api();
  const result = await getIndicatorMap(client, { indicator: "ai002_1_5", level: "kreis", year: 2024, fields: ["AI0201"], limit: 4 });
  assert.equal(result.total, 11);
  assert.deepEqual(result.rows?.map((r) => r.ags), ["02", "03361", "07316", "09162"]);
  assert.deepEqual(result.rows?.[0]?.values, { ai0201: 2466.7 });
  assert.equal(result.nextOffset, 4);
  assert.deepEqual(result.fields, [{ code: "ai0201", title: "Bevölkerungsdichte (EW je qkm)", unit: "Anzahl" }]);
  assert.ok(result.notes?.some((n) => n.includes("2 with a 2-digit key, 9 with a 5-digit key")), result.notes?.join("\n"));
});

/** AI002-1-5's first year (2000) per Land, two rows with special values. */
const FIRST_YEAR = {
  "ai002_1_5/1/2000": [
    { id: 1, typ: 1, ags: "01", jahr: 2000, gen: "Schleswig-Holstein", ai0201: 177.4, ai0202: 2222222222, ai0201v: 2222222222 },
    { id: 2, typ: 1, ags: "02", jahr: 2000, gen: "Hamburg", ai0201: 2253.1, ai0202: 5555555555, ai0201v: 2222222222 },
  ],
};

test("getIndicatorMap: 'nichts vorhanden' is exactly 0, but a change rate in the indicator's first year is null: no previous year", async () => {
  const { client } = api({ rows: FIRST_YEAR });
  const result = await getIndicatorMap(client, { indicator: "AI002-1-5", year: 2000 });
  const [sh, hh] = result.rows ?? [];
  assert.equal(sh?.values["ai0202"], 0);
  assert.equal(sh?.missing?.["ai0202"], "nichts vorhanden");
  assert.equal(sh?.values["ai0201v"], null);
  assert.match(sh?.missing?.["ai0201v"] ?? "", /no previous year/);
  assert.equal(hh?.values["ai0202"], null);
  assert.equal(hh?.missing?.["ai0202"], "Wert geheim zu halten");
  assert.deepEqual(result.coverage?.["ai0202"], { withFigure: 1, withoutFigure: 1, special: { "nichts vorhanden": 1, "Wert geheim zu halten": 1 } });
  assert.ok(result.notes?.some((n) => n.includes("exactly zero")));
});

/**
 * The recorded catalogue with AI013-1's 2025 entry per value column, as the live catalogue has it
 * (entry i describes attributes[i]): ai1301 with figures, ai1301v with none at any level (as
 * AI002-4-5's ai0219 in 2025 live). The data host writes "nichts vorhanden" for it everywhere.
 */
function unpublishedColumn() {
  const catalog = (JSON.parse(JSON.stringify(RECORDED_CATALOG)) as { children: { code: string; years: Record<string, unknown[]> }[] }[]).map((theme) => ({
    ...theme,
    children: theme.children.map((child) => (child.code === "AI013-1" ? { ...child, years: { ...child.years, "2025": [{ geom_levels: [16, 29, 396, 0] }, { geom_levels: [0, 0, 0, 0] }] } } : child)),
  }));
  const rows = { "ai013_1/1/2025": CARS_LAND_2025.map((r) => ({ ...r, ai1301v: 2222222222 })) };
  return api({ catalog, rows });
}

test("a column the catalogue publishes no figure for that year is no figure, not 'nichts vorhanden' as 0", async () => {
  const { client } = unpublishedColumn();
  const rows = await client.query({ indicator: "AI013-1", year: 2025 });
  assert.equal(rows[0]?.values["ai1301"], 592.7);
  assert.equal(rows[0]?.values["ai1301v"], null);
  assert.match(rows[0]?.missing?.["ai1301v"] ?? "", /not published/);
  const map = await getIndicatorMap(client, { indicator: "AI013-1", year: 2025 });
  assert.equal(map.coverage?.["ai1301v"]?.withFigure, 0);
  assert.ok(!map.notes?.some((n) => n.includes("exactly zero")), String(map.notes));
  assert.ok(map.notes?.some((n) => /ai1301v/.test(n) && /publishes no figure/.test(n)), String(map.notes));
  const compared = await compareRegions(client, { indicator: "AI013-1", field: "ai1301v", year: 2025 });
  assert.equal(compared.status, "empty");
  assert.match(compared.reason ?? "", /publishes no figure for ai1301v in 2025/);
  assert.equal(compared.levelStats?.mean, undefined);
});

test("getIndicatorMap: value columns the catalogue doesn't name are left out, with a note naming them", async () => {
  const extra: Record<string, number> = {};
  for (let i = 0; i < 1000; i++) extra[`ai05_extra_${String(i).padStart(4, "0")}`] = i;
  const rows = { "ai005/1/2025": ELECTION_LAND_2025.map((r) => ({ ...r, ...extra })) };
  const { client } = api({ rows });
  const map = await getIndicatorMap(client, { indicator: "AI005", year: 2025 });
  assert.equal(map.status, "ok");
  assert.deepEqual(Object.keys(map.rows?.[0]?.values ?? {}).sort(), ["ai0501", "ai0502", "ai0503", "ai0504", "ai0505", "ai0506", "ai0507"]);
  assert.equal(Object.keys(map.coverage ?? {}).length, 7);
  assert.equal(map.fields?.length, 7);
  assert.ok(map.notes?.some((n) => /1000 value columns the catalogue doesn't name/.test(n) && n.includes("ai05_extra_0000") && n.length < 400), String(map.notes));
});

test("an indicator whose catalogue entry lost its years or its columns says the catalogue is incomplete", async () => {
  const change = (edit: (child: Record<string, unknown>) => void) => {
    const catalog = structuredClone(RECORDED_CATALOG) as { children: Record<string, unknown>[] }[];
    const ai005 = catalog.flatMap((t) => t.children).find((c) => c["code"] === "AI005");
    if (ai005 === undefined) throw new Error("fixture");
    edit(ai005);
    return api({ catalog });
  };
  for (const edit of [(c: Record<string, unknown>) => delete c["years"], (c: Record<string, unknown>) => (c["years"] = ["2025"])]) {
    const { client, mock } = change(edit);
    const map = await getIndicatorMap(client, { indicator: "AI005" });
    assert.equal(map.status, "empty");
    assert.match(map.reason ?? "", /catalogue lists no year for AI005/);
    assert.doesNotMatch(map.reason ?? "", /published at \./);
    assert.equal(dataRequests(mock).length, 0);
  }
  const noLevels = change((c) => (c["years"] = { "2025": [{ geom_levels: [0, 0, 0, 0] }] }));
  const empty = await getIndicatorMap(noLevels.client, { indicator: "AI005" });
  assert.match(empty.reason ?? "", /publishes no figures for AI005 at any level in any year/);
  const noColumns = change((c) => delete c["attributes"]);
  const map = await getIndicatorMap(noColumns.client, { indicator: "AI005", year: 2025 });
  assert.equal(map.status, "ok");
  assert.ok(map.notes?.some((n) => /catalogue names no value columns for AI005/.test(n)), String(map.notes));
  const compared = await compareRegions(noColumns.client, { indicator: "AI005", year: 2025 });
  assert.match(compared.reason ?? "", /catalogue names no value columns for AI005/);
});

test("a year whose rows carry no figure at all (boundary rows only) counts as not loaded: the year before, with the note", async () => {
  const nulls = CARS_LAND_2025.map((r) => ({ ...r, jahr: 2026, jahr2: 2026, ai1301: null, ai1301v: null }));
  const { client } = api({ rows: { "ai013_1/1/2026": nulls } });
  const map = await getIndicatorMap(client, { indicator: "AI013-1" });
  assert.equal(map.status, "ok");
  assert.equal(map.year, 2025);
  assert.ok(map.notes?.some((n) => n.includes("2026 is the newest year")), String(map.notes));
  const compared = await compareRegions(client, { indicator: "AI013-1", field: "ai1301", regions: ["Bayern"] });
  assert.equal(compared.year, 2025);
  assert.equal(compared.regions?.[0]?.value, 635);
  const named = await getIndicatorMap(client, { indicator: "AI013-1", year: 2026 });
  assert.equal(named.status, "empty");
  assert.match(named.reason ?? "", /no rows \(or no figures\) for AI013-1 at level land in 2026/);
});

test("a region the data host sends twice is shown once, with a note; its name and key then resolve", async () => {
  const bayern = ELECTION_LAND_2025.find((r) => r["ags"] === "09");
  const { client } = api({ rows: { "ai005/1/2025": [...ELECTION_LAND_2025, { ...bayern, id: 1 } as (typeof ELECTION_LAND_2025)[number]] } });
  const map = await getIndicatorMap(client, { indicator: "AI005", year: 2025 });
  assert.equal(map.total, 16);
  assert.ok(map.notes?.some((n) => /sent 1 region twice \(09\)/.test(n)), String(map.notes));
  for (const asked of ["Bayern", "09"]) {
    const compared = await compareRegions(client, { indicator: "AI005", field: "ai0506", year: 2025, regions: [asked] });
    assert.equal(compared.status, "ok", asked);
    assert.equal(compared.levelStats?.regions, 16);
  }
});

// --- compareRegions ---

test("compareRegions: an indicator with several columns and no field is ambiguous with the columns, before any data request", async () => {
  const { client, mock } = api();
  const result = await compareRegions(client, { indicator: "AI005", regions: ["Bayern"] });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates?.length, 7);
  assert.equal(dataRequests(mock).length, 0);
});

test("compareRegions: named Länder ranked against all 16, highest first; Sachsen is Sachsen, the others containing it named", async () => {
  const { client } = api();
  const result = await compareRegions(client, { indicator: "AI005", field: "ai0507", regions: ["Sachsen", "Bayern", "08"] });
  assert.equal(result.status, "ok");
  assert.equal(result.field?.title, "Zweitstimmenanteil AfD, Bundestagswahl");
  assert.deepEqual(result.regions?.map((r) => [r.name, r.value, r.rank, r.matchedBy]), [
    ["Sachsen", 37.3, 2, "name"],
    ["Bayern", 19, 9, "name"],
    ["Baden-Württemberg", 19.8, 8, "ags"],
  ].sort((a, b) => (b[1] as number) - (a[1] as number)));
  assert.deepEqual(result.regions?.find((r) => r.name === "Sachsen")?.alsoNamed?.map((r) => r.name), ["Niedersachsen", "Sachsen-Anhalt"]);
  assert.equal(result.levelStats?.regions, 16);
  assert.equal(result.levelStats?.highest?.name, "Thüringen");
  assert.equal(result.levelStats?.mean, 23.18, "one decimal more than the figures carry, not 23.18125");
  assert.equal(result.levelStats?.median, 19.4);
  assert.equal(result.regions?.find((r) => r.name === "Sachsen")?.vsMean, 14.12);
  assert.ok(result.notes?.some((n) => /mean and median are of the 16 regions' values, unweighted/.test(n) && /not the figure for Germany/.test(n)), String(result.notes));
});

test("compareRegions: a name several Kreise contain is ambiguous with the candidates; an exact name wins and names the rest; a Land is not at kreis", async () => {
  const { client } = api();
  const result = await compareRegions(client, { indicator: "AI002-1-5", field: "ai0201", level: "kreis", year: 2024, regions: ["München", "Neustadt", "Bayern", "09162000"] });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.ambiguousRegions?.[0]?.candidates.map((c) => c.ags).sort(), ["07316", "09374", "09575"]);
  assert.match(result.ambiguousRegions?.[0]?.reason ?? "", /No region is named exactly this; 3 contain it/);
  assert.deepEqual(result.regions?.map((r) => [r.asked, r.ags]), [["München", "09162"]], "the official 8-digit key of München is the same Kreis: listed once");
  assert.ok(result.notes?.some((n) => n.includes('"09162000" names the same region as "München"')), String(result.notes));
  const withTop = await compareRegions(client, { indicator: "AI002-1-5", field: "ai0201", level: "kreis", year: 2024, regions: ["Leipzig"], top: 3 });
  assert.ok(withTop.notes?.some((n) => /top applies only without regions/.test(n)), String(withTop.notes));
  assert.deepEqual(result.regions?.[0]?.alsoNamed, [{ ags: "09184", name: "München, Landkreis" }]);
  assert.match(result.notFound?.[0]?.reason ?? "", /No region at level kreis has this name/);
  assert.equal(result.notFound?.[0]?.asked, "Bayern");
});

test("compareRegions: 'Landkreis München', 'Stadt München', 'Kreisfreie Stadt Leipzig' and 'Muenchen' find their region", async () => {
  const { client } = api();
  const ask = (regions: string[]) => compareRegions(client, { indicator: "AI002-1-5", field: "ai0201", level: "kreis", year: 2024, regions });
  const found = await ask(["Landkreis München", "Landkreis Verden", "Stadt München", "Kreisfreie Stadt Leipzig"]);
  assert.equal(found.status, "ok", JSON.stringify(found.notFound ?? found.ambiguousRegions));
  assert.deepEqual(
    Object.fromEntries((found.regions ?? []).map((r) => [r.asked, [r.ags, r.matchedBy]])),
    { "Landkreis München": ["09184", "name-form"], "Landkreis Verden": ["03361", "name-form"], "Stadt München": ["09162", "name-form"], "Kreisfreie Stadt Leipzig": ["14713", "name-form"] },
  );
  const spelled = await ask(["Muenchen"]);
  assert.deepEqual(spelled.regions?.map((r) => [r.ags, r.matchedBy]), [["09162", "name"]]);
  const missing = await ask(["Landkreis Leipzig"]);
  assert.equal(missing.status, "empty");
  assert.match(missing.notFound?.[0]?.reason ?? "", /names a Landkreis/);
});

test("compareRegions: an exact name that is a Landkreis while a city's name contains it (Offenbach) is ambiguous; long names say which is which", async () => {
  const offenbach = [
    { id: 1, typ: 3, ags: "06438", jahr: 2024, gen: "Offenbach", jahr2: 2024, ags2: "06438", gen2: "      Offenbach, Landkreis", ai0201: 1000.1 },
    { id: 2, typ: 3, ags: "06413", jahr: 2024, gen: "Offenbach am Main", jahr2: 2024, ags2: "06413", gen2: "      Offenbach am Main, kreisfreie Stadt", ai0201: 2900.5 },
  ];
  const { client } = api({ rows: { "ai002_1_5/3/2024": [...POPULATION_KREIS_2024, ...offenbach] } });
  const ask = (regions: string[]) => compareRegions(client, { indicator: "AI002-1-5", field: "ai0201", level: "kreis", year: 2024, regions });
  const result = await ask(["Offenbach"]);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.ambiguousRegions?.[0]?.candidates, [
    { ags: "06438", name: "Offenbach", longName: "Offenbach, Landkreis" },
    { ags: "06413", name: "Offenbach am Main", longName: "Offenbach am Main, kreisfreie Stadt" },
  ]);
  assert.match(result.ambiguousRegions?.[0]?.reason ?? "", /Landkreis/);
  const munich = await ask(["München"]);
  assert.equal(munich.status, "ok", "the exact München is the city");
  assert.equal(munich.regions?.[0]?.longName, "München, kreisfreie Stadt");
  assert.deepEqual(munich.regions?.[0]?.alsoNamed, [{ ags: "09184", name: "München, Landkreis" }]);
});

test("compareRegions: without regions, the highest and lowest of the level; regions without a figure out of ranks and mean", async () => {
  const rows = { "ai005/1/2025": ELECTION_LAND_2025.map((r) => (r["ags"] === "16" ? { ...r, ai0507: 5555555555 } : r)) };
  const { client } = api({ rows });
  const result = await compareRegions(client, { indicator: "AI005", field: "ai0507", year: 2025, top: 2 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.highest?.map((r) => [r.name, r.rank]), [["Sachsen", 1], ["Sachsen-Anhalt", 2]]);
  assert.deepEqual(result.lowest?.map((r) => r.name), ["Hamburg", "Bremen"]);
  assert.equal(result.levelStats?.withFigure, 15);
  assert.equal(result.levelStats?.withoutFigure, 1);
  assert.ok(result.notes?.some((n) => n.includes("1 of 16 regions have no figure")));
});

test("compareRegions: 'nichts vorhanden' ranks as 0, the reason kept", async () => {
  const rows = { "ai013_1/1/2025": CARS_LAND_2025.map((r) => (r["ags"] === "11" ? { ...r, ai1301: 2222222222 } : r)) };
  const { client } = api({ rows });
  const result = await compareRegions(client, { indicator: "AI013-1", field: "ai1301", year: 2025, regions: ["Berlin"] });
  assert.deepEqual([result.regions?.[0]?.value, result.regions?.[0]?.rank, result.regions?.[0]?.missing], [0, 16, "nichts vorhanden"]);
});

// --- The SQL guard ---

test("only the catalogue's table, the level's typ and a catalogue year reach the data host's SQL", async () => {
  const { client, mock } = api();
  await compareRegions(client, { indicator: " ai005 ", field: "ai0507", level: "land", year: 2025, regions: ["' OR 1=1 --", "Bayern"] });
  const [request] = dataRequests(mock);
  assert.equal(
    sqlOf(request as never)?.sql,
    "SELECT * FROM verwaltungsgrenzen_gesamt LEFT OUTER JOIN ai005 ON ags = ags2 and jahr = jahr2 WHERE typ = 1 AND jahr = 2025 AND (jahr2 = 2025 OR jahr2 IS NULL)",
  );
  assert.ok(mock.calls.every((call) => !decodeURIComponent(call.url).includes("OR 1=1")), "a region's text is matched in the rows, never sent");
});

test("an indicator text that is no catalogue code never reaches the data host, whatever it holds", async () => {
  const { client, mock } = api();
  for (const indicator of [
    "ai005 UNION SELECT * FROM verwaltungsgrenzen_gesamt",
    "ai005; DROP TABLE ai005",
    "ai005' OR '1'='1",
    "verwaltungsgrenzen_gesamt",
    "ai005/**/",
    "AI005--",
  ]) {
    const map = await getIndicatorMap(client, { indicator });
    assert.notEqual(map.status, "ok", indicator);
    const compared = await compareRegions(client, { indicator, field: "ai0507" });
    assert.notEqual(compared.status, "ok", indicator);
  }
  assert.equal(dataRequests(mock).length, 0);
});

test("a catalogue entry whose code isn't a plain code is left out, so it can't be named either", async () => {
  const catalog = [{ title: "Böse", children: [{ code: "ai005 UNION SELECT 1", title_short: "Bundestagswahl", years: { "2025": [] }, attributes: [] }] }];
  const { client, mock } = api({ catalog });
  const result = await getIndicatorMap(client, { indicator: "ai005 UNION SELECT 1", year: 2025 });
  assert.equal(result.status, "empty");
  assert.equal(dataRequests(mock).length, 0);
});

// --- The catalogue's age ---

test("calls that need the catalogue at the same time share one download (listThemes asks for it twice)", async () => {
  const catalogueRequests = (mock: ReturnType<typeof regionalatlasApi>) => mock.calls.length - dataRequests(mock).length;
  const both = regionalatlasApi();
  const client = new RegionalatlasClient({ transport: both.transport, catalogMaxAgeMs: 3_600_000 });
  const [themes] = await Promise.all([listThemes(client), findIndicators(client, { search: "AI005" })]);
  assert.equal(themes.status, "ok");
  assert.equal(catalogueRequests(both), 1);
  // A shared download that fails on the network (the call that started it was cancelled) fails
  // only its starter: a waiter downloads it once more on its own.
  let first = true;
  const flaky = regionalatlasApi();
  const shaky = new RegionalatlasClient({
    transport: async (request) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw Object.assign(new Error("socket hang up"), { code: "ECONNREFUSED" });
      }
      return flaky.transport(request);
    },
    maxRetries: 0,
  });
  const [starter, waiter] = await Promise.allSettled([shaky.indicators(), shaky.indicators()]);
  assert.equal(starter.status, "rejected");
  assert.equal(waiter.status, "fulfilled");
});

test("catalogMaxAgeMs: the catalogue is fetched again once it is older; unset, once per client", async () => {
  const catalogueRequests = (mock: ReturnType<typeof regionalatlasApi>) => mock.calls.length - dataRequests(mock).length;
  const once = regionalatlasApi();
  const client = new RegionalatlasClient({ transport: once.transport });
  await client.indicators();
  await client.themes();
  assert.equal(catalogueRequests(once), 1);
  const always = regionalatlasApi();
  const fresh = new RegionalatlasClient({ transport: always.transport, catalogMaxAgeMs: 0 });
  await fresh.indicators();
  await fresh.indicators();
  assert.equal(catalogueRequests(always), 2);
  const hour = regionalatlasApi();
  const cached = new RegionalatlasClient({ transport: hour.transport, catalogMaxAgeMs: 3_600_000 });
  await cached.indicators();
  await cached.indicators();
  assert.equal(catalogueRequests(hour), 1);
  assert.throws(() => new RegionalatlasClient({ catalogMaxAgeMs: -1 }), RegionalatlasValidationError);
  assert.throws(() => new RegionalatlasClient({ catalogMaxAgeMs: 1.5 }), RegionalatlasValidationError);
});
