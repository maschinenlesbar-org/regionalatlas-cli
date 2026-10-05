// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { RegionalatlasClient as Client } from "../src/client/client.js";
import { RegionalatlasValidationError as ValidationError } from "../src/client/errors.js";
import { catalog, landData } from "./fixtures.js";
// regionalatlas filters on the client: the only filter that goes out is the SQL's level
// (`typ`) and year, so the adapter reads those back; `region` and `fields` never leave.
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.query(query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { indicator: "AI002-1-5", level: "kreis", year: 2020 } };
const GOOD_SENT = "WHERE typ = 3 AND jahr = 2020 AND (jahr2 = 2020 OR jahr2 IS NULL)";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => {
  const layer = new URL(req.url).searchParams.get("layer");
  const sql = layer === null ? "" : (JSON.parse(layer) as { source: { dataSource: { query: string } } }).source.dataSource.query;
  return /WHERE .*$/.exec(sql)?.[0] ?? null;
};
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { ...GOOD.query, bundesland: "09" }],
  ["misspelled key", { indicator: "AI002-1-5", levle: "kreis", year: 2020 }],
  ["wrong-case key", { indicator: "AI002-1-5", Level: "kreis", year: 2020 }],
  ["__proto__ key", JSON.parse('{"indicator": "AI002-1-5", "__proto__": {"level": "kreis"}}') as Record<string, unknown>],
];
/** Queries whose filter names the API doesn't have (here: the level, the one filter sent). */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["unknown name", { ...GOOD.query, level: "bezirk" }],
  ["misspelled name", { ...GOOD.query, level: "kries" }],
  ["__proto__ name", { ...GOOD.query, level: "__proto__" }],
  ["constructor name", { ...GOOD.query, level: "constructor" }],
  ["a typ number", { ...GOOD.query, level: "3" }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array level", { ...GOOD.query, level: ["kreis", "land"] }],
  ["object level", { ...GOOD.query, level: { name: "kreis" } }],
  ["NaN year", { ...GOOD.query, year: Number.NaN }],
  ["array year", { ...GOOD.query, year: [2020, 2024] }],
  ["array region", { ...GOOD.query, region: ["Gera", "Jena"] }],
  ["object fields", { ...GOOD.query, fields: { ai0201: true } }],
];
/**
 * Queries that differ from GOOD only in how a filter name is spelled (decomposed umlaut,
 * padding, case): the API ignores such a name. "normalise" = sent as GOOD_SENT; "reject" =
 * the validation error.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded name", { ...GOOD.query, level: " kreis " }],
  ["upper case", { ...GOOD.query, level: "KREIS" }],
  ["alias", { ...GOOD.query, level: "Landkreise" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice (`--fields`, repeatable), and what the repo does with it. */
const REPEATED_FLAG_ARGV = ["query", "AI002-1-5", "--level", "kreis", "--year", "2020", "--fields", "ai0201", "--fields", "ai0202"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["query", "AI002-1-5", "--level", "kreis", "--year", "2020", "--region", "Gera", "--region", "Jena"];
const USAGE_EXIT = 2;
/** True for a request that fetches data (not the catalogue the client checks names with). */
const isDataRequest = (req: HttpRequest): boolean => new URL(req.url).pathname.includes("/dynamicLayer/");
/** The answer to any request. */
const respond = (req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: Buffer.from(JSON.stringify(isDataRequest(req) ? landData : catalog)),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
