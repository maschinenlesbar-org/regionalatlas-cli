// This server's tools against a mock of both Regionalatlas hosts (the client's recorded answers of
// 2026-11-20), through the protocol (each structuredContent checked by the SDK against its output
// schema), with the skills' traps as cases: a column topic found in the value columns, a text
// that is no code answered with candidates, the newest year not loaded yet, a region name several
// regions share or contain reported, never resolved. One --base-url names a mirror of both hosts.
// And the SQL guard through every tool input: only the catalogue's table, the level's typ and a
// catalogue year reach the data host. The rules every server follows are the conformance tests
// (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/mcp/api.js";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { regionalatlasApi, sqlOf } from "./helpers.js";

const CATALOGUE = "https://regionalatlas.statistikportal.de/taskrunner/services.json";
const DATA = "https://www.gis-idmz.nrw.de/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query";

const dataRequests = (mock: ReturnType<typeof regionalatlasApi>) => mock.calls.filter((call) => call.url.includes("/dynamicLayer/query"));

test("four tools: the three use cases first, then the themes", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findIndicators", "getIndicatorMap", "compareRegions", "listThemes"]);
});

test("findIndicators: Wahlbeteiligung is a column of AI005, found with the column named; the source is the catalogue", async () => {
  const connection = await connect({ transport: regionalatlasApi() });
  const result = await connection.call("findIndicators", { search: "Wahlbeteiligung" });
  const answer = result.structuredContent ?? {};
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.deepEqual((answer["indicators"] as { code: string; matchedFields: string[] }[]).map((i) => [i.code, i.matchedFields]), [["AI005", ["ai0506"]]]);
  assert.equal(answer["source"], CATALOGUE);
  assert.match(String(answer["licence"]), /dl-de\/by-2-0/);
  await connection.close();
});

test("getIndicatorMap: the newest year not loaded yet: the year before, the note saying so; the source is the data host's query", async () => {
  const connection = await connect({ transport: regionalatlasApi() });
  const answer = (await connection.call("getIndicatorMap", { indicator: "AI013-1", fields: ["ai1301"] })).structuredContent ?? {};
  assert.equal(answer["status"], "ok");
  assert.equal(answer["year"], 2025);
  assert.equal(answer["total"], 16);
  assert.deepEqual(answer["fields"], [{ code: "ai1301", title: "Pkw-Bestand je 1.000 EW am 01.01.", unit: "Anzahl" }]);
  assert.ok((answer["notes"] as string[]).some((n) => n.includes("2026 is the newest year")));
  assert.equal(answer["source"], DATA);
  await connection.close();
});

test("getIndicatorMap: a title is no code: the indicators it matches as candidates, no data request", async () => {
  const mock = regionalatlasApi();
  const connection = await connect({ transport: mock });
  const answer = (await connection.call("getIndicatorMap", { indicator: "Bundestagswahl" })).structuredContent ?? {};
  assert.equal(answer["status"], "ambiguous");
  assert.deepEqual(answer["candidates"], [{ code: "AI005", titleShort: "Bundestagswahl" }]);
  assert.equal(dataRequests(mock).length, 0);
  await connection.close();
});

test("compareRegions: München is the city (the Landkreis named), Neustadt ambiguous with its candidates, Bayern not a Kreis", async () => {
  const connection = await connect({ transport: regionalatlasApi() });
  const answer = (await connection.call("compareRegions", { indicator: "AI002-1-5", field: "ai0201", level: "kreis", year: 2024, regions: ["München", "Neustadt", "Bayern"] })).structuredContent ?? {};
  assert.equal(answer["status"], "ambiguous");
  const [muenchen] = answer["regions"] as { ags: string; alsoNamed: { name: string }[] }[];
  assert.equal(muenchen?.ags, "09162");
  assert.deepEqual(muenchen?.alsoNamed.map((r) => r.name), ["München, Landkreis"]);
  assert.equal((answer["ambiguousRegions"] as { candidates: unknown[] }[])[0]?.candidates.length, 3);
  assert.deepEqual((answer["notFound"] as { asked: string }[]).map((r) => r.asked), ["Bayern"]);
  await connection.close();
});

test("compareRegions: several value columns and none named is ambiguous with the columns; the highest and lowest without regions", async () => {
  const connection = await connect({ transport: regionalatlasApi() });
  const pick = (await connection.call("compareRegions", { indicator: "AI005" })).structuredContent ?? {};
  assert.equal(pick["status"], "ambiguous");
  assert.equal((pick["candidates"] as unknown[]).length, 7);
  const turnout = (await connection.call("compareRegions", { indicator: "AI005", field: "ai0506", top: 1 })).structuredContent ?? {};
  assert.equal(turnout["year"], 2025);
  assert.deepEqual((turnout["highest"] as { name: string; value: number }[]).map((r) => [r.name, r.value]), [["Bayern", 84.3]]);
  assert.equal((turnout["field"] as { title: string }).title, "Wahlbeteiligung, Bundestagswahl");
  await connection.close();
});

test("listThemes: the themes with their indicators", async () => {
  const connection = await connect({ transport: regionalatlasApi() });
  const answer = (await connection.call("listThemes", {})).structuredContent ?? {};
  assert.equal(answer["total"], 5);
  assert.deepEqual((answer["themes"] as { title: string }[]).map((t) => t.title), ["Bevölkerung", "Wahlen", "Verkehr", "Gesundheitsökonomische Gesamtrechnungen", "Zensus"]);
  await connection.close();
});

test("one --base-url is a mirror of both hosts: the catalogue and the data query go there, and the sources say so", async () => {
  const mock = regionalatlasApi();
  const connection = await connect({ transport: mock, config: { baseUrl: "https://mirror.example/atlas" } });
  const answer = (await connection.call("getIndicatorMap", { indicator: "AI005", year: 2025, limit: 1 })).structuredContent ?? {};
  assert.equal(answer["status"], "ok");
  assert.deepEqual(mock.calls.map((c) => new URL(c.url).origin + new URL(c.url).pathname), [
    "https://mirror.example/atlas/taskrunner/services.json",
    "https://mirror.example/atlas/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query",
  ]);
  assert.equal(answer["source"], "https://mirror.example/atlas/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query");
  const found = (await connection.call("findIndicators", { search: "AI005" })).structuredContent ?? {};
  assert.equal(found["source"], "https://mirror.example/atlas/taskrunner/services.json");
  await connection.close();
});

test("the server keeps the catalogue for hours, not for its lifetime: the client gets a maximum age", async () => {
  const mock = regionalatlasApi();
  const client = new Client({ transport: mock.transport });
  await client.indicators();
  await client.indicators();
  assert.equal(mock.calls.length, 1, "kept between calls");
  assert.throws(() => new Client({ transport: mock.transport, catalogUrl: "ftp://x" }));
});

// --- The SQL guard, through the tools ---

test("only the catalogue's table, the level's typ and a catalogue year reach the SQL; a region's text is never sent", async () => {
  const mock = regionalatlasApi();
  const connection = await connect({ transport: mock });
  const answer = (await connection.call("compareRegions", { indicator: "ai005", field: "ai0507", level: "land", year: 2025, regions: ["Bayern' OR '1'='1", "x); DROP TABLE ai005; --"] })).structuredContent ?? {};
  assert.equal(answer["status"], "empty");
  const [request] = dataRequests(mock);
  assert.equal(
    sqlOf(request as never)?.sql,
    "SELECT * FROM verwaltungsgrenzen_gesamt LEFT OUTER JOIN ai005 ON ags = ags2 and jahr = jahr2 WHERE typ = 1 AND jahr = 2025 AND (jahr2 = 2025 OR jahr2 IS NULL)",
  );
  assert.ok(mock.calls.every((call) => !/DROP|'1'='1/.test(decodeURIComponent(call.url))));
  await connection.close();
});

test("an indicator text that holds SQL is no catalogue code: answered from the catalogue, no data request, through both data tools", async () => {
  const mock = regionalatlasApi();
  const connection = await connect({ transport: mock });
  for (const indicator of [
    "ai005 UNION SELECT * FROM verwaltungsgrenzen_gesamt",
    "ai005; DROP TABLE ai005",
    "ai005' OR '1'='1",
    "verwaltungsgrenzen_gesamt",
    "ai005 WHERE 1=1 --",
  ]) {
    const map = await connection.call("getIndicatorMap", { indicator, year: 2025 });
    assert.notEqual(map.isError, true, map.content[0]?.text);
    assert.notEqual(map.structuredContent?.["status"], "ok", indicator);
    const compared = await connection.call("compareRegions", { indicator, field: "ai0507", year: 2025 });
    assert.notEqual(compared.structuredContent?.["status"], "ok", indicator);
  }
  assert.equal(dataRequests(mock).length, 0);
  await connection.close();
});

test("a level, a year or a value column outside its schema is a tool error before any request", async () => {
  const mock = regionalatlasApi();
  const connection = await connect({ transport: mock });
  for (const [name, args] of [
    ["getIndicatorMap", { indicator: "AI005", level: "land OR 1=1" }],
    ["getIndicatorMap", { indicator: "AI005", year: "2025 OR 1=1" }],
    ["getIndicatorMap", { indicator: "AI005", year: 2025.5 }],
    ["getIndicatorMap", { indicator: "AI005", fields: ["ai0507 FROM x"] }],
    ["compareRegions", { indicator: "AI005", field: "ai0507'--" }],
    ["compareRegions", { indicator: "AI005", field: "ai0507", level: "typ = 1" }],
    ["findIndicators", { level: "1; DROP" }],
  ] as const) {
    const result = await connection.call(name, args as unknown as Record<string, unknown>);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(mock.calls.length, 0);
  await connection.close();
});
