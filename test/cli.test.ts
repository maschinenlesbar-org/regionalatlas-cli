import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, queryOf, routeByHost } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new RegionalatlasClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** A CLI wired to the host-routing transport (catalogue + data). */
function makeRoutingCli(data: unknown = fx.landData) {
  return makeCli(routeByHost(fx.catalog, data));
}

function dataCalls(calls: HttpRequest[]): HttpRequest[] {
  return calls.filter((c) => new URL(c.url).hostname.includes("gis-idmz"));
}

test("themes lists the subject areas with indicator counts", async () => {
  const cli = makeRoutingCli();
  const code = await run(["themes"], cli.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { title: string; indicatorCount: number }[];
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { title: "Gebiet und Fläche", indicatorCount: 1 });
});

test("indicators lists code + titleShort + years, honouring --search", async () => {
  const cli = makeRoutingCli();
  const code = await run(["indicators", "--search", "bevölkerung"], cli.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { code: string; years: string }[];
  assert.ok(parsed.length >= 1);
  assert.ok(parsed.some((p) => p.code === "AI002-1-5"));
  assert.ok(parsed.find((p) => p.code === "AI002-1-5")!.years.includes("2024"));
});

test("indicators --year filters by available year", async () => {
  const cli = makeRoutingCli();
  await run(["indicators", "--year", "2024"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { code: string }[];
  assert.deepEqual(parsed.map((p) => p.code), ["AI002-1-5"]);
});

test("query fetches rows for an indicator at the default land level", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI002-1-5", "--year", "2020"], cli.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { ags: string; name: string; level: string }[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.level, "land");
  // The data request embedded the right SQL.
  const layer = JSON.parse(queryOf(dataCalls(cli.mt.calls)[0]!).get("layer") ?? "{}") as {
    source: { dataSource: { query: string } };
  };
  assert.match(layer.source.dataSource.query, /JOIN ai002_1_5 ON/);
  assert.match(layer.source.dataSource.query, /typ = 1 AND jahr = 2020/);
});

test("query --level kreis maps to typ 3 in the SQL", async () => {
  const cli = makeRoutingCli();
  await run(["query", "AI002-1-5", "--level", "kreis", "--year", "2020"], cli.deps);
  const layer = JSON.parse(queryOf(dataCalls(cli.mt.calls)[0]!).get("layer") ?? "{}") as {
    source: { dataSource: { query: string } };
  };
  assert.match(layer.source.dataSource.query, /typ = 3 AND jahr = 2020/);
});

test("query --region and --fields are applied client-side", async () => {
  const cli = makeRoutingCli();
  await run(["query", "AI002-1-5", "--year", "2020", "--region", "Bremen", "--fields", "ai0201"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { name: string; values: Record<string, number> }[];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, "Bremen");
  assert.deepEqual(parsed[0]!.values, { ai0201: 1620.8 });
  // Upstream still requested all fields.
  assert.equal(queryOf(dataCalls(cli.mt.calls)[0]!).get("outFields"), "*");
});

test("an unknown indicator is a usage error (exit 2) and makes no data request", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI999-9-9"], cli.deps);
  assert.equal(code, 2);
  assert.equal(dataCalls(cli.mt.calls).length, 0);
  assert.match(cli.err.join("\n"), /Unknown indicator/);
});

test("an unknown --level is rejected at parse time (exit 2), no request at all", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI002-1-5", "--level", "galaxy"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Unknown geo level/);
});

test("a non-4-digit --year is rejected at parse time (exit 2)", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI002-1-5", "--year", "20"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a year outside the indicator's range is a usage error (exit 2), no data request", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI002-1-5", "--year", "1999"], cli.deps);
  assert.equal(code, 2);
  assert.equal(dataCalls(cli.mt.calls).length, 0);
  assert.match(cli.err.join("\n"), /not available/);
});

test("an ArcGIS error envelope surfaces as an error (exit 1)", async () => {
  const cli = makeCli(routeByHost(fx.catalog, fx.arcgisError));
  const code = await run(["query", "AI002-1-5", "--year", "2020"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Invalid or missing input parameters/);
});

test("a control character in --user-agent is rejected (exit 2)", async () => {
  const cli = makeRoutingCli();
  const code = await run(["themes", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("an empty --base-url is rejected (exit 2)", async () => {
  const cli = makeRoutingCli();
  const code = await run(["--base-url", "", "themes"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http(s) --catalog-url scheme is rejected at parse time (exit 2)", async () => {
  const cli = makeRoutingCli();
  const code = await run(["--catalog-url", "file:///etc/passwd", "themes"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeRoutingCli();
  const code = await run(["--max-retries", "1000000", "themes"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: regionalatlas/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeRoutingCli();
  await run(["themes", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});
