import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertKnownFields,
  assertLevelPublished,
  filterIndicators,
  findField,
  parseIndicators,
  parseThemes,
  resolveIndicator,
  resolveYear,
  tableForCode,
} from "../src/client/catalog.js";
import { RegionalatlasValidationError } from "../src/client/errors.js";
import * as fx from "./fixtures.js";

test("tableForCode lowercases and replaces hyphens with underscores", () => {
  assert.equal(tableForCode("AI002-1-5"), "ai002_1_5");
  assert.equal(tableForCode("AI001-2-5"), "ai001_2_5");
});

test("parseThemes returns each theme with its indicator count", () => {
  const themes = parseThemes(fx.catalog);
  assert.deepEqual(themes, [
    { title: "Gebiet und Fläche", indicatorCount: 1 },
    { title: "Bevölkerung", indicatorCount: 2 },
  ]);
});

test("parseIndicators flattens the catalogue with table + theme + sorted years", () => {
  const indicators = parseIndicators(fx.catalog);
  assert.equal(indicators.length, 3);
  const ai002 = indicators.find((i) => i.code === "AI002-1-5");
  assert.ok(ai002);
  assert.equal(ai002.table, "ai002_1_5");
  assert.equal(ai002.theme, "Bevölkerung");
  assert.deepEqual(ai002.years, ["2000", "2020", "2024"]);
});

test("parseIndicators reads the field dictionary out of the catalogue attributes", () => {
  const ai002 = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5");
  assert.ok(ai002);
  // Codes are lower-cased so they match the keys of a parsed RegionRow's `values`,
  // and stay in catalogue order — the order the data host returns them in.
  assert.deepEqual(ai002.fields, [
    { code: "ai0201", title: "Bevölkerungsdichte (EW je qkm)", unit: "Anzahl" },
    { code: "ai0202", title: "Bevölkerungsentwicklung je 10.000 EW", unit: "Anzahl" },
    {
      code: "ai0201v",
      title: "Bevölkerungsdichte (EW je qkm) (Veränderungsrate)",
      unit: "Prozent",
    },
  ]);
});

test("parseIndicators tolerates a catalogue entry with no or malformed attributes", () => {
  const raw = [
    {
      title: "T",
      children: [
        { code: "A-1", years: { "2020": [] } },
        { code: "A-2", years: { "2020": [] }, attributes: "nope" },
        { code: "A-3", years: { "2020": [] }, attributes: [null, {}, { code: "  X1 " }] },
      ],
    },
  ];
  const [a1, a2, a3] = parseIndicators(raw);
  assert.deepEqual(a1?.fields, []);
  assert.deepEqual(a2?.fields, []);
  // Null/code-less entries are skipped; a real one is trimmed and lower-cased.
  assert.deepEqual(a3?.fields, [{ code: "x1", title: "", unit: "" }]);
});

test("findField matches a value column case-insensitively", () => {
  const ai002 = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5");
  assert.ok(ai002);
  assert.equal(findField(ai002, "AI0201")?.unit, "Anzahl");
  assert.equal(findField(ai002, " ai0201v ")?.unit, "Prozent");
  assert.equal(findField(ai002, "nonsense"), undefined);
});

test("parseThemes/parseIndicators reject a non-array catalogue", () => {
  assert.throws(() => parseThemes({} as unknown), /expected a JSON array/i);
  assert.throws(() => parseIndicators("nope" as unknown), /expected a JSON array/i);
});

test("filterIndicators: theme substring is case-insensitive", () => {
  const all = parseIndicators(fx.catalog);
  const res = filterIndicators(all, { theme: "bevölk" });
  assert.equal(res.length, 2);
  assert.ok(res.every((i) => i.theme === "Bevölkerung"));
});

test("filterIndicators: year membership", () => {
  const all = parseIndicators(fx.catalog);
  const res = filterIndicators(all, { year: 2024 });
  assert.deepEqual(res.map((i) => i.code), ["AI002-1-5"]);
});

test("filterIndicators: search over code + short + long title", () => {
  const all = parseIndicators(fx.catalog);
  assert.deepEqual(filterIndicators(all, { search: "ALTERSGRUPPEN" }).map((i) => i.code), ["AI002-2-5"]);
  assert.deepEqual(filterIndicators(all, { search: "ai002-1-5" }).map((i) => i.code), ["AI002-1-5"]);
});

test("resolveIndicator accepts the code form (case-insensitive, hyphen or underscore)", () => {
  const all = parseIndicators(fx.catalog);
  assert.equal(resolveIndicator(all, "AI002-1-5").table, "ai002_1_5");
  assert.equal(resolveIndicator(all, "ai002-1-5").table, "ai002_1_5");
  assert.equal(resolveIndicator(all, "AI002_1_5").table, "ai002_1_5");
});

test("resolveIndicator accepts the table form", () => {
  const all = parseIndicators(fx.catalog);
  assert.equal(resolveIndicator(all, "ai002_1_5").code, "AI002-1-5");
});

test("resolveIndicator rejects a bogus code with a typed validation error", () => {
  const all = parseIndicators(fx.catalog);
  assert.throws(() => resolveIndicator(all, "AI999-9-9"), RegionalatlasValidationError);
  // Injection attempts are just "unknown indicators" — rejected the same way.
  assert.throws(() => resolveIndicator(all, "ai002_1_5; DROP TABLE x"), RegionalatlasValidationError);
  assert.throws(() => resolveIndicator(all, "verwaltungsgrenzen_gesamt"), RegionalatlasValidationError);
});

test("resolveYear defaults to the latest available year when omitted", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.equal(resolveYear(ind), 2024);
});

test("resolveYear accepts a year present in the indicator's list", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.equal(resolveYear(ind, 2020), 2020);
});

test("resolveYear rejects a non-integer or out-of-range year", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.throws(() => resolveYear(ind, 2019), RegionalatlasValidationError); // not in list
  assert.throws(() => resolveYear(ind, 2020.5), RegionalatlasValidationError); // non-integer
});

test("assertKnownFields accepts known columns and rejects the rest", () => {
  const ai002 = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.doesNotThrow(() => assertKnownFields(ai002, ["AI0201", " ai0201v "]));
  assert.throws(
    () => assertKnownFields(ai002, ["ai0201", "typo", "alsobad"]),
    (err: unknown) => {
      assert.ok(err instanceof RegionalatlasValidationError);
      assert.match(err.message, /Unknown value fields "typo", "alsobad"/);
      assert.match(err.message, /Available: ai0201 \(/);
      return true;
    },
  );
});

test("assertKnownFields stays out of the way when the catalogue lists no columns", () => {
  const bare = parseIndicators([
    { title: "T", children: [{ code: "A-1", years: { "2020": [] } }] },
  ])[0]!;
  // The field dictionary is a convenience; an upstream that stops publishing it
  // must not turn every --fields query into a usage error.
  assert.doesNotThrow(() => assertKnownFields(bare, ["anything"]));
});

test("a hyphenated attribute code (Zensus 2011) is keyed like the data host's column", () => {
  // Live: AI-Z1-2011 lists its columns as AI-Z01 … AI-Z07, and the data host returns
  // them as ai_z01 … ai_z07 (the same - → _ mapping as the table name).
  const raw = [
    {
      title: "Zensus",
      children: [
        {
          code: "AI-Z1-2011",
          years: { "2011": [] },
          attributes: [{ code: "AI-Z01", title_short: "Durchschnittsalter", unit: "Anzahl" }],
        },
      ],
    },
  ];
  const [zensus] = parseIndicators(raw);
  assert.ok(zensus);
  assert.deepEqual(zensus.fields, [{ code: "ai_z01", title: "Durchschnittsalter", unit: "Anzahl" }]);
  // Both spellings find the column, so neither is refused as unknown.
  assert.equal(findField(zensus, "ai_z01")?.code, "ai_z01");
  assert.equal(findField(zensus, "AI-Z01")?.code, "ai_z01");
  assert.doesNotThrow(() => assertKnownFields(zensus, ["ai_z01", "AI-Z01"]));
});

/** A catalogue shaped like the live AIGG-01 (Land only) and AI008-2 (a year with nothing). */
const levelCatalog = [
  {
    title: "Gesundheit",
    children: [
      {
        code: "AIGG-01",
        years: {
          "2021": [{ geom_levels: [16, 0, 0, 0] }, { geom_levels: [16, 0, 0, 0] }],
          "2022": [{ geom_levels: [16, 0, 0, 0] }, { geom_levels: [16, 0, 0, 0] }],
        },
      },
      {
        code: "AI008-2",
        years: {
          "2006": [{ geom_levels: [0, 0, 0, 0] }],
          "2014": [{ geom_levels: [16, 0, 398, 0] }, { geom_levels: [16, 0, 0, 0] }],
          "2020": [],
        },
      },
    ],
  },
];

test("parseIndicators records per year the levels the catalogue has figures for", () => {
  const [aigg, ai008] = parseIndicators(levelCatalog);
  assert.deepEqual({ ...aigg!.levels }, { "2021": ["land"], "2022": ["land"] });
  // A level counts when any column has figures there; an empty year entry is unknown.
  assert.deepEqual({ ...ai008!.levels }, { "2006": [], "2014": ["land", "kreis"] });
});

test("a level without figures in that year is refused, naming the published ones", () => {
  const [aigg, ai008] = parseIndicators(levelCatalog);
  assert.doesNotThrow(() => assertLevelPublished(aigg!, "land", 2022));
  assert.throws(
    () => assertLevelPublished(aigg!, "kreis", 2022),
    (err: unknown) =>
      err instanceof RegionalatlasValidationError &&
      err.message ===
        'Indicator "AIGG-01" has no figures at level kreis in 2022: the catalogue publishes it only ' +
          "at level land, so every kreis row would be null. Use --level land. The catalogue lists no " +
          "year with figures at level kreis.",
  );
  assert.throws(
    () => assertLevelPublished(ai008!, "land", 2006),
    /no figures for 2006 at any level .* Years with figures at level land: 2014, 2020\.$/,
  );
  assert.throws(() => assertLevelPublished(ai008!, "gemeinde", 2014), /only at levels land, kreis, so every gemeinde row would be null\. Use --level kreis\./);
  // Unknown level information (an empty year entry) is not checked.
  assert.doesNotThrow(() => assertLevelPublished(ai008!, "gemeinde", 2020));
});

test("malformed geom_levels leave the year unchecked rather than refusing it", () => {
  const raw = [
    {
      title: "T",
      children: [
        {
          code: "X-1",
          years: {
            "2020": [{ geom_levels: [16, 0, 0] }],
            "2021": [{ geom_levels: [16, 0, "400", 0] }],
            "2022": [{ precision: 1 }],
            "2023": {},
          },
        },
      ],
    },
  ];
  const [x] = parseIndicators(raw);
  assert.deepEqual({ ...x!.levels }, {});
  assert.doesNotThrow(() => assertLevelPublished(x!, "kreis", 2021));
});

test("the suggested level is the published one closest to the requested level", () => {
  const raw = [
    { title: "T", children: [{ code: "AI019-3-5", years: { "2022": [{ geom_levels: [0, 0, 30, 1394] }] } }] },
  ];
  const [ind] = parseIndicators(raw);
  assert.throws(
    () => assertLevelPublished(ind!, "land", 2022),
    /only at levels kreis, gemeinde, so every land row would be null\. Use --level kreis\./,
  );
});

test("malformed catalogue codes, year keys and column names are left out when parsing", () => {
  const raw = [
    {
      title: "T",
      children: [
        { code: "X1 UNION SELECT", years: { "2020": [] } },
        { code: "Z\u001b[31mRED", years: { "2020": [] } },
        null,
        5,
        { code: "Y2", years: { "20x0": [], abcd: [] } },
        { code: "Y3", years: { "99999": [], "2020": [], "0999": [] } },
        {
          code: "Y4",
          years: { "2020": [] },
          attributes: [{ code: "ai0201" }, { code: "ai\u001b0202" }, { code: "a b" }],
        },
      ],
    },
  ];
  const indicators = parseIndicators(raw);
  assert.deepEqual(indicators.map((i) => i.code), ["Y2", "Y3", "Y4"]);
  assert.deepEqual(indicators[0]!.years, []);
  assert.deepEqual(indicators[1]!.years, ["2020"]);
  assert.equal(resolveYear(indicators[1]!), 2020);
  assert.deepEqual(indicators[2]!.fields.map((f) => f.code), ["ai0201"]);
  // themes counts what `indicators` lists.
  assert.deepEqual(parseThemes(raw), [{ title: "T", indicatorCount: 3 }]);
  // An indicator left with no valid year is a validation error, not an internal one.
  assert.throws(() => resolveYear(indicators[0]!), RegionalatlasValidationError);
});

test("catalogue texts lose control and bidi characters and line breaks before any message", () => {
  const raw = [
    {
      title: "Th\u001b]0;pwn\u0007eme",
      children: [
        {
          code: "Y6",
          title_short: "Short‮title",
          title_long: "Long\ntitle",
          years: { "2020": [] },
          attributes: [{ code: "ai0201", title_short: "t\u001b]0;TITLE\u0007\u001b[31mRED", unit: "Pro\u009bzent" }],
        },
      ],
    },
  ];
  const [ind] = parseIndicators(raw);
  assert.equal(ind!.theme, "Th]0;pwneme");
  assert.equal(ind!.titleShort, "Shorttitle");
  assert.equal(ind!.titleLong, "Long title");
  assert.deepEqual(ind!.fields, [{ code: "ai0201", title: "t]0;TITLE[31mRED", unit: "Prozent" }]);
  assert.deepEqual(parseThemes(raw), [{ title: "Th]0;pwneme", indicatorCount: 1 }]);
  assert.throws(
    () => assertKnownFields(ind!, ["nope"]),
    (err: unknown) =>
      err instanceof Error && err.message.endsWith("Available: ai0201 (t]0;TITLE[31mRED).") &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(err.message),
  );
});
