// --region: an exact name wins over substring hits, an ambiguous answer is named on
// stderr, and a zero-padded official key matches the shorter key a level carries
// (findings 01#1 and 06#1 of the 2026-10-05 review; the names and keys are the live ones
// from that review's saved replies).

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRegion, filterByRegion, RegionalatlasClient } from "../src/client/client.js";
import type { RegionRow } from "../src/client/types.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { catalog } from "./fixtures.js";
import { untimed } from "./helpers.js";

const row = (ags: string, name: string): RegionRow => ({ ags, name, typ: 3, level: "kreis", year: 2024, values: {} });
const names = (rows: RegionRow[]): string[] => rows.map((r) => `${r.ags} ${r.name}`);

const LAND = [row("03", "Niedersachsen"), row("14", "Sachsen"), row("15", "Sachsen-Anhalt"), row("09", "Bayern")];
const KREIS = [
  row("06433", "Groß-Gerau"),
  row("16052", "Gera"),
  row("12069", "Potsdam-Mittelmark"),
  row("12054", "Potsdam"),
  row("09184", "München, Landkreis"),
  row("09162", "München"),
  row("06438", "Offenbach"),
  row("06413", "Offenbach am Main"),
  row("11", "Berlin"),
  row("02", "Hamburg"),
];
const GEMEINDE = [
  row("08335008", "Berlingen"),
  row("11", "Berlin"),
  row("01053129", "Wentorf bei Hamburg"),
  row("02", "Hamburg"),
  row("09162", "München"),
  row("05315", "Köln"),
  row("03241001", "Hannover"),
  row("15002000", "Halle (Saale)"),
  row("07331501", "Halle"),
  row("03254020", "Halle"),
];

test("a whole-name match wins over substring hits; the left-out rows are reported", () => {
  for (const [rows, input, want] of [
    [LAND, "Sachsen", "14 Sachsen"],
    [LAND, "sachsen", "14 Sachsen"],
    [KREIS, "Gera", "16052 Gera"],
    [KREIS, "Potsdam", "12054 Potsdam"],
    [KREIS, "München", "09162 München"],
    [KREIS, "Offenbach", "06438 Offenbach"],
    [GEMEINDE, "Berlin", "11 Berlin"],
    [GEMEINDE, "Hamburg", "02 Hamburg"],
    [GEMEINDE, "München", "09162 München"],
  ] as const) {
    const m = matchRegion([...rows], input);
    assert.equal(m.by, "name", input);
    assert.deepEqual(names(m.rows), [want], input);
    assert.ok(m.others.length > 0 || input.startsWith("Mu"), input);
  }
  assert.deepEqual(names(matchRegion(LAND, "Sachsen").others), ["03 Niedersachsen", "15 Sachsen-Anhalt"]);
});

test("without a whole-name match every name containing the text matches; a shared name matches all", () => {
  const sub = matchRegion(LAND, "sachs");
  assert.equal(sub.by, "substring");
  assert.deepEqual(names(sub.rows), ["03 Niedersachsen", "14 Sachsen", "15 Sachsen-Anhalt"]);
  const shared = matchRegion(GEMEINDE, "Halle");
  assert.equal(shared.by, "name");
  assert.deepEqual(names(shared.rows), ["07331501 Halle", "03254020 Halle"]);
  assert.deepEqual(names(shared.others), ["15002000 Halle (Saale)"]);
  assert.equal(matchRegion(LAND, "Nowhere").by, "none");
});

test("a key: exact (leading zeros ignored), else the zero-padded official key of a coarser row", () => {
  for (const [rows, input, by, want] of [
    [KREIS, "16052", "ags", "16052 Gera"],
    [KREIS, "9162", "ags", "09162 München"],
    [KREIS, "11", "ags", "11 Berlin"],
    [KREIS, "11000", "ags-filled", "11 Berlin"],
    [KREIS, "02000", "ags-filled", "02 Hamburg"],
    [KREIS, "2000", "ags-filled", "02 Hamburg"],
    [GEMEINDE, "09162000", "ags-filled", "09162 München"],
    [GEMEINDE, "9162000", "ags-filled", "09162 München"],
    [GEMEINDE, "05315000", "ags-filled", "05315 Köln"],
    [GEMEINDE, "11000000", "ags-filled", "11 Berlin"],
    [GEMEINDE, "02000000", "ags-filled", "02 Hamburg"],
    [GEMEINDE, "03241001", "ags", "03241001 Hannover"],
  ] as const) {
    const m = matchRegion([...rows], input);
    assert.equal(m.by, by, input);
    assert.deepEqual(names(m.rows), [want], input);
  }
  // A padded key with a non-zero rest, or one that pads nothing, matches nothing.
  for (const input of ["09162001", "0", "00", "10", "11000001"]) {
    assert.deepEqual(matchRegion(GEMEINDE, input).rows, [], input);
  }
  assert.deepEqual(names(filterByRegion(GEMEINDE, "09162000")), ["09162 München"]);
});

function cli(rows: Array<[string, string]>) {
  const data = {
    features: rows.map(([ags, gen], id) => ({ attributes: { id, typ: 1, ags, gen, jahr: 2020, ai0201: id } })),
  };
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(new URL(req.url).hostname.includes("statistikportal") ? catalog : data)),
  });
  return {
    deps: { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, createClient: (o: object) => new RegionalatlasClient({ ...o, transport }) },
    out,
    err,
  };
}

const LAND_ROWS: Array<[string, string]> = [["03", "Niedersachsen"], ["14", "Sachsen"], ["15", "Sachsen-Anhalt"], ["09", "Bayern"]];

test("CLI: an exact name prints one row and names what it left out", async () => {
  const c = cli(LAND_ROWS);
  assert.equal(await run(["--compact", "query", "AI002-1-5", "--year", "2020", "--region", "Sachsen"], c.deps), 0);
  assert.deepEqual((JSON.parse(c.out.join("")) as RegionRow[]).map((r) => r.name), ["Sachsen"]);
  assert.deepEqual(c.err.map(untimed), [
    'INFO  [regionalatlas.api] --region "Sachsen" matched the name exactly; left out 2 rows that only contain it: ' +
      "03 Niedersachsen, 15 Sachsen-Anhalt (pick one of those by its AGS).",
  ]);
});

test("CLI: an ambiguous region prints every row and says it is ambiguous", async () => {
  const c = cli(LAND_ROWS);
  assert.equal(await run(["--compact", "query", "AI002-1-5", "--year", "2020", "--region", "sachs"], c.deps), 0);
  assert.equal((JSON.parse(c.out.join("")) as RegionRow[]).length, 3);
  assert.deepEqual(c.err.map(untimed), [
    'INFO  [regionalatlas.api] --region "sachs" is ambiguous: 3 rows contain it in their name (no name equals it): ' +
      "03 Niedersachsen, 14 Sachsen, 15 Sachsen-Anhalt. Pick one region by its AGS (--region <ags>).",
  ]);
});

test("CLI: an unambiguous name or key prints no note; a padded key says what it matched", async () => {
  for (const region of ["Bayern", "09", "9"]) {
    const c = cli(LAND_ROWS);
    assert.equal(await run(["query", "AI002-1-5", "--year", "2020", "--region", region], c.deps), 0);
    assert.deepEqual(c.err, [], region);
  }
  const c = cli([["11", "Berlin"], ["09162", "München"]]);
  assert.equal(await run(["--compact", "query", "AI002-1-5", "--year", "2020", "--region", "09162000"], c.deps), 0);
  assert.deepEqual((JSON.parse(c.out.join("")) as RegionRow[]).map((r) => r.ags), ["09162"]);
  assert.match(untimed(c.err.join("\n")), /^INFO  \[regionalatlas\.api\] no row at level land has the key "09162000"; matched 09162 München, which this level carries under the shorter key/);
});
