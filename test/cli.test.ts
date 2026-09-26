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

test("an indicators listing that matches nothing says so on stderr, exit 0", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--search", "zzzz", "--compact"], cli.deps), 0);
  assert.equal(cli.out.join("\n"), "[]");
  assert.match(cli.err.join("\n"), /none of the 3 catalogue indicators match --search "zzzz"/);
});

test("an empty indicators listing filtered by year names the catalogue's year span", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--year", "1997", "--compact"], cli.deps), 0);
  assert.match(cli.err.join("\n"), /--year 1997\. The catalogue covers 2000–2024\./);
});

test("a non-empty indicators listing stays quiet on stderr", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--compact"], cli.deps), 0);
  assert.deepEqual(cli.err, []);
});

test("a free-text option refuses to swallow the next option as its value", async () => {
  for (const argv of [
    ["query", "AI002-1-5", "--region", "--fields"],
    ["indicators", "--search", "--theme"],
    ["indicators", "--theme", "-h"],
  ]) {
    const cli = makeRoutingCli();
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /looks like a missing value/);
  }
});

test("a dash-leading term that is not an option is still a valid filter", async () => {
  // Indicator codes are full of hyphens, so `--search -1-5` is a real query. The
  // sibling CLIs' blanket dash rejection would refuse it with no way to escape it.
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--search", "-1-5"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { code: string }[];
  assert.deepEqual(parsed.map((p) => p.code), ["AI002-1-5"]);
});

test("an unknown --fields name is a usage error (exit 2) and makes no data request", async () => {
  const cli = makeRoutingCli();
  const code = await run(["query", "AI002-1-5", "--year", "2020", "--fields", "ai0201,nonsense"], cli.deps);
  assert.equal(code, 2);
  // Caught against the catalogue, so no rows are fetched only to project to {}.
  assert.equal(dataCalls(cli.mt.calls).length, 0);
  assert.match(cli.err.join("\n"), /Unknown value field "nonsense"/);
  // The message names what the indicator does offer.
  assert.match(cli.err.join("\n"), /ai0201 \(Bevölkerungsdichte/);
});

test("a Veränderungsrate column is a valid --fields name", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020", "--fields", "ai0201v"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { values: Record<string, number> }[];
  assert.deepEqual(parsed[0]!.values, { ai0201v: 0.1 });
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

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["--timeout", "2147483647", "themes"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeRoutingCli();
  assert.equal(await run(["--timeout", "2147483648", "themes"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const name = `Nieder${controls}`;
  const ags = String.fromCharCode(0x1b) + "[31m";
  const feature = { attributes: { ...fx.landData.features[0]!.attributes, gen: name, ags } };
  const served = { ...fx.landData, features: [feature] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeRoutingCli(served);
    assert.equal(await run([...format, "query", "AI002-1-5", "--year", "2020"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Nieder\\u007f\\u0085\\u009b2J/);
    const rows = JSON.parse(text) as { name: string; ags: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, name);
    assert.equal(rows[0]!.ags, ags);
  }
});

test("--compact prints single-line JSON", async () => {
  const cli = makeRoutingCli();
  await run(["themes", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("indicators includes the long title that --search also matches", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--search", "altersgruppen"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { code: string; titleLong: string }[];
  assert.deepEqual(parsed, [
    {
      code: "AI002-2-5",
      table: "ai002_2_5",
      theme: "Bevölkerung",
      titleShort: "Bevölkerung nach Altersgruppen",
      titleLong: "Themenbereich Bevölkerung — Altersgruppen",
      years: "2019–2020",
      fields: [{ code: "ai0203", title: "Anteil unter 18-Jährige", unit: "Prozent" }],
    },
  ]);
});

test("indicators names each value column, so --fields needs no probing query", async () => {
  const cli = makeRoutingCli();
  assert.equal(await run(["indicators", "--search", "bevölkerungsstand"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as {
    fields: { code: string; title: string; unit: string }[];
  }[];
  assert.deepEqual(
    parsed[0]?.fields.map((f) => `${f.code} (${f.unit})`),
    ["ai0201 (Anzahl)", "ai0202 (Anzahl)", "ai0201v (Prozent)"],
  );
});

test("an empty result with the defaulted newest year prints [] and a note to try the previous year", async () => {
  const cli = makeRoutingCli({ ...fx.landData, features: [] });
  assert.equal(await run(["query", "AI002-1-5", "--level", "kreis", "--compact"], cli.deps), 0);
  assert.equal(cli.out.join("\n"), "[]");
  // The defaulted year is the newest catalogue year, and the catalogue was fetched once.
  const layer = JSON.parse(queryOf(dataCalls(cli.mt.calls)[0]!).get("layer") ?? "{}") as {
    source: { dataSource: { query: string } };
  };
  assert.match(layer.source.dataSource.query, /typ = 3 AND jahr = 2024/);
  assert.equal(cli.mt.calls.length, 2);
  assert.deepEqual(cli.err, [
    "Note: the data host returned no rows for AI002-1-5 at level kreis in 2024. " +
      "2024 is the newest year in the catalogue, but its data may not be loaded yet; try --year 2020.",
  ]);
});

test("an empty result for an explicit year notes it without a year hint", async () => {
  const cli = makeRoutingCli({ ...fx.landData, features: [] });
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], cli.deps), 0);
  assert.equal(JSON.stringify(JSON.parse(cli.out.join("\n"))), "[]");
  assert.deepEqual(cli.err, ["Note: the data host returned no rows for AI002-1-5 at level land in 2020."]);
});

test("a --region that matches nothing notes the region, no note when rows remain", async () => {
  const none = makeRoutingCli();
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020", "--region", "Bayern"], none.deps), 0);
  assert.deepEqual(none.err, ['Note: no rows for AI002-1-5 at level land in 2020 match --region "Bayern".']);

  const some = makeRoutingCli();
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020", "--region", "Bremen"], some.deps), 0);
  assert.deepEqual(some.err, []);
});

test("a Zensus column is selectable by the data key and by the catalogue's hyphenated code", async () => {
  const catalog = [
    {
      title: "Zensus",
      children: [
        {
          code: "AI-Z1-2011",
          years: { "2011": [] },
          attributes: [
            { code: "AI-Z01", title_short: "Durchschnittsalter", unit: "Anzahl" },
            { code: "AI-Z02", title_short: "Durchschnittsalter Männer", unit: "Anzahl" },
          ],
        },
      ],
    },
  ];
  const data = {
    features: [{ attributes: { ags: "11", gen: "Berlin", jahr: 2011, ai_z01: 42.3, ai_z02: 43.6 } }],
  };
  for (const name of ["ai_z01", "AI-Z01"]) {
    const cli = makeCli(routeByHost(catalog, data));
    const code = await run(["--compact", "query", "AI-Z1-2011", "--fields", name], cli.deps);
    assert.equal(code, 0, cli.err.join("\n"));
    const rows = JSON.parse(cli.out.join("\n")) as { values: Record<string, number> }[];
    assert.deepEqual(rows[0]!.values, { ai_z01: 42.3 });
  }
  const list = makeCli(routeByHost(catalog, data));
  await run(["--compact", "indicators"], list.deps);
  const listed = JSON.parse(list.out.join("\n")) as { fields: { code: string }[] }[];
  assert.deepEqual(listed[0]!.fields.map((f) => f.code), ["ai_z01", "ai_z02"]);
});

test("a level the indicator has no figures at is a usage error before the data request", async () => {
  const catalog = [
    {
      title: "Gesundheit",
      children: [
        { code: "AIGG-01", years: { "2022": [{ geom_levels: [16, 0, 0, 0] }] } },
      ],
    },
  ];
  const cli = makeCli(routeByHost(catalog, fx.landData));
  const code = await run(["query", "AIGG-01", "--level", "kreis"], cli.deps);
  assert.equal(code, 2);
  assert.equal(dataCalls(cli.mt.calls).length, 0);
  assert.match(cli.err.join("\n"), /no figures at level kreis in 2022: .* Use --level land\./);
  const ok = makeCli(routeByHost(catalog, fx.landData));
  assert.equal(await run(["query", "AIGG-01", "--level", "land"], ok.deps), 0);
});

test("a malformed catalogue entry is never reported as an unexpected error", async () => {
  const catalog = [
    {
      title: "T",
      children: [
        { code: "X1 UNION SELECT", years: { "2020": [] } },
        { code: "Y2", years: { "20x0": [], abcd: [] } },
        { code: "Y3", years: { "99999": [], "2020": [] } },
        { code: "Y7", years: { "0999": [], "2020": [] } },
      ],
    },
  ];
  const cases: [string[], number, RegExp][] = [
    [["query", "X1 UNION SELECT"], 2, /Unknown indicator/],
    [["query", "Y2"], 2, /has no years listed/],
    [["query", "Y7", "--year", "0999"], 2, /Year 999 is not available .* Available: 2020\./],
  ];
  for (const [argv, exit, message] of cases) {
    const cli = makeCli(routeByHost(catalog, fx.landData));
    assert.equal(await run(argv, cli.deps), exit, argv.join(" "));
    assert.match(cli.err.join("\n"), message);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    assert.equal(dataCalls(cli.mt.calls).length, 0);
  }
  const y3 = makeCli(routeByHost(catalog, fx.landData));
  assert.equal(await run(["query", "Y3"], y3.deps), 0);
  assert.match(queryOf(dataCalls(y3.mt.calls)[0]!).get("layer") ?? "", /jahr = 2020/);
});

test("hostile catalogue text and an escape-laden argument never reach stderr raw", async () => {
  const catalog = [
    {
      title: "T",
      children: [
        {
          code: "Y6",
          years: { "2020": [], "20\u001b]0;pwned\u000721": [] },
          attributes: [{ code: "ai0201", title_short: "t\u001b]0;TITLE\u0007\u001b[31mRED" }],
        },
      ],
    },
  ];
  const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  for (const argv of [
    ["query", "Y6", "--year", "2020", "--fields", "nope"],
    ["query", "Y6", "--year", "1999"],
    ["query", "Z\u001b[31mRED\u009b2J"],
  ]) {
    const cli = makeCli(routeByHost(catalog, fx.landData));
    assert.equal(await run(argv, cli.deps), 2);
    const stderr = cli.err.join("\n");
    assert.match(stderr, /^Error: /);
    assert.doesNotMatch(stderr, controls, JSON.stringify(stderr));
  }
});
