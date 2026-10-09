import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, queryOf, rawResponse, routeByHost, untimed } from "./helpers.js";
import { credentialsIn } from "../src/client/errors.js";
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
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[regionalatlas\.api\] none of the 3 catalogue indicators match --search "zzzz"/);
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
      years: ["2019", "2020"],
      levels: {},
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
  assert.deepEqual(cli.err.map(untimed), [
    "INFO  [regionalatlas.api] the data host returned no rows for AI002-1-5 at level kreis in 2024. " +
      "2024 is the newest year in the catalogue, but its data may not be loaded yet; try --year 2020.",
  ]);
});

test("an empty host reply with --region blames the year, not the region", async () => {
  const cli = makeRoutingCli({ ...fx.landData, features: [] });
  assert.equal(await run(["query", "AI002-1-5", "--region", "11"], cli.deps), 0);
  assert.deepEqual(cli.err.map(untimed), [
    "INFO  [regionalatlas.api] the data host returned no rows for AI002-1-5 at level land in 2024 (before --region was applied). " +
      "2024 is the newest year in the catalogue, but its data may not be loaded yet; try --year 2020.",
  ]);
});

test("an empty result for an explicit year notes it without a year hint", async () => {
  const cli = makeRoutingCli({ ...fx.landData, features: [] });
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], cli.deps), 0);
  assert.equal(JSON.stringify(JSON.parse(cli.out.join("\n"))), "[]");
  assert.deepEqual(cli.err.map(untimed), ["INFO  [regionalatlas.api] the data host returned no rows for AI002-1-5 at level land in 2020."]);
});

test("a --region that matches nothing notes the region, no note when rows remain", async () => {
  const none = makeRoutingCli();
  assert.equal(await run(["query", "AI002-1-5", "--region", "Bayern"], none.deps), 0);
  // The host returned rows, so the year is not the suspect: no "try --year" hint.
  assert.deepEqual(none.err.map(untimed), [
    'INFO  [regionalatlas.api] none of the 2 rows for AI002-1-5 at level land in 2024 match --region "Bayern" ' +
      "(a name, a part of one, or an AGS).",
  ]);

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
    // The catalogue's "0999" key is left out, and --year 0999 is not a 4-digit year.
    [["query", "Y7", "--year", "0999"], 2, /Expected a 4-digit year/],
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
    assert.match(untimed(stderr), /^ERROR \[regionalatlas\.cli\] /);
    assert.doesNotMatch(stderr, controls, JSON.stringify(stderr));
  }
});

test("a maintenance reply exits 1 with the shape error and no empty-result note", async () => {
  const cli = makeCli(routeByHost(fx.catalog, { status: "maintenance" }));
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], cli.deps), 1);
  assert.equal(cli.out.length, 0);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[regionalatlas\.api\] Unexpected response shape from .*expected a features array, got none\.$/);
  assert.doesNotMatch(untimed(cli.err.join("\n")), /^INFO /m);
});

test("a result cut off at the host's record limit prints the rows and a note", async () => {
  const cli = makeRoutingCli({ ...fx.landData, exceededTransferLimit: true });
  assert.equal(await run(["--compact", "query", "AI002-1-5", "--year", "2020"], cli.deps), 0);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 2);
  assert.deepEqual(cli.err.map(untimed), [
    "WARN  [regionalatlas.api] the data host stopped at its record limit after 2 rows (exceededTransferLimit), " +
      "so the result is incomplete. Query a coarser --level.",
  ]);
});

test("a --base-url with a query, fragment or surrounding whitespace is a usage error", async () => {
  for (const [url, message] of [
    ["http://127.0.0.1:1/m?token=abc", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:1/m#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    [" http://127.0.0.1:1/m", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeRoutingCli();
    assert.equal(await run(["--base-url", url, "query", "AI002-1-5"], cli.deps), 2, url);
    assert.match(cli.err.join("\n"), message);
    assert.equal(cli.mt.calls.length, 0);
  }
  // A mirror path prefix and userinfo stay allowed.
  const ok = makeRoutingCli();
  assert.equal(await run(["--base-url", "https://user:pw@gis-idmz.example/mirror/", "themes"], ok.deps), 0);
});

test("userinfo in --base-url is redacted from error messages but still sent", async () => {
  const cli = makeCli((req) =>
    new URL(req.url).hostname.includes("statistikportal")
      ? jsonResponse(fx.catalog)
      : jsonResponse({ error: { code: 404, message: "nope" } }, 404),
  );
  const code = await run(
    ["--base-url", "http://user:secret@gis-idmz.example/m", "query", "AI002-1-5", "--year", "2020"],
    cli.deps,
  );
  assert.equal(code, 4);
  const stderr = cli.err.join("\n");
  assert.doesNotMatch(stderr, /secret/);
  // The plain-http: warning comes first, naming the credentials without printing them.
  assert.equal(untimed(cli.err[0] ?? ""), "WARN  [regionalatlas.http] the base URL's credentials are sent unencrypted to gis-idmz.example (http:, not https:)");
  assert.match(untimed(stderr), /^ERROR \[regionalatlas\.api\] HTTP 404 for GET http:\/\/\*\*\*@gis-idmz\.example\/m\/arcgis\//m);
  assert.equal(new URL(cli.mt.last().url).password, "secret");
});

test("a repeated --fields adds to the list instead of keeping only the last one", async () => {
  const cli = makeRoutingCli();
  const code = await run(
    ["--compact", "query", "AI002-1-5", "--year", "2020", "--fields", "ai0201", "--fields", "ai0201v"],
    cli.deps,
  );
  assert.equal(code, 0);
  const rows = JSON.parse(cli.out.join("\n")) as { values: Record<string, number> }[];
  assert.deepEqual(rows[0]!.values, { ai0201: 167.8, ai0201v: 0.1 });
});

test("a blank or non-Latin-1 --user-agent is a usage error; tab and Latin-1 pass", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["agent ☃", /outside Latin-1 \(above U\+00FF\)/],
  ] as const) {
    const cli = makeRoutingCli();
    assert.equal(await run(["--user-agent", ua, "themes"], cli.deps), 2, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message);
    assert.equal(cli.mt.calls.length, 0);
  }
  const ok = makeRoutingCli();
  assert.equal(await run(["--user-agent", "mü\tagent", "themes"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "mü\tagent");
});

test("P11: --level with a decomposed umlaut works like the composed alias (finding 02#1)", async () => {
  const { run } = await import("../src/cli/run.js");
  const { RegionalatlasClient } = await import("../src/client/client.js");
  const { routeByHost } = await import("./helpers.js");
  const fx = await import("./fixtures.js");
  for (const level of ["bundesländer", "länder"]) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: string[] = [];
    const respond = routeByHost(fx.catalog, fx.landData);
    const code = await run(["--compact", "query", "AI002-1-5", "--year", "2020", "--level", level], {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      createClient: (opts) =>
        new RegionalatlasClient({ ...opts, transport: async (req) => (sent.push(req.url), respond(req)) }),
    });
    assert.equal(code, 0, err.join("\n"));
    assert.ok(sent.some((u) => decodeURIComponent(u).includes("typ = 1")), sent.join("\n"));
  }
});

test("the size-cap hint fits the download: the catalogue, or a data reply (finding 07#1)", async () => {
  const { run } = await import("../src/cli/run.js");
  const { RegionalatlasClient } = await import("../src/client/client.js");
  const fx = await import("./fixtures.js");
  const big = { ...fx.landData, padding: "x".repeat(5000) };
  for (const [argv, catalogBody, wantHint] of [
    [["--max-response-bytes", "1000", "themes"], [...fx.catalog, { title: "x".repeat(5000), children: [] }], /indicator catalogue \(about 2 MB\).*Raise --max-response-bytes/],
    [["--max-response-bytes", "1000", "indicators"], [...fx.catalog, { title: "x".repeat(5000), children: [] }], /indicator catalogue \(about 2 MB\)/],
    [["--max-response-bytes", "4000", "query", "AI002-1-5", "--year", "2020"], fx.catalog, /coarser --level/],
  ] as const) {
    const err: string[] = [];
    const code = await run([...argv], {
      io: { out: () => {}, err: (s) => err.push(s) },
      createClient: (opts) =>
        new RegionalatlasClient({
          ...opts,
          transport: async (req) => ({
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(new URL(req.url).hostname.includes("statistikportal") ? catalogBody : big)),
          }),
        }),
    });
    assert.equal(code, 6, err.join("\n"));
    assert.match(err.join("\n"), wantHint);
    const args: readonly string[] = argv;
    if (args.includes("themes") || args.includes("indicators")) assert.doesNotMatch(err.join("\n"), /--level/);
  }
});

// ---- REGIONALATLAS_BASE_URL: flag > variable > default ----

function makeEnvCli(env: Record<string, string>) {
  const cli = makeRoutingCli();
  cli.deps.env = env;
  return cli;
}

/** The data-host requests (everything that is not the catalogue host). */
function dataHostCalls(calls: HttpRequest[]): HttpRequest[] {
  return calls.filter((c) => !new URL(c.url).hostname.includes("statistikportal"));
}

test("REGIONALATLAS_BASE_URL sets the data host; --base-url wins over it", async () => {
  const fromEnv = makeEnvCli({ REGIONALATLAS_BASE_URL: "https://mirror.example/prefix" });
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], fromEnv.deps), 0, fromEnv.err.join("\n"));
  assert.match(dataHostCalls(fromEnv.mt.calls)[0]!.url, /^https:\/\/mirror\.example\/prefix\/arcgis\//);

  const fromFlag = makeEnvCli({ REGIONALATLAS_BASE_URL: "https://mirror.example" });
  const argv = ["--base-url", "https://other.example", "query", "AI002-1-5", "--year", "2020"];
  assert.equal(await run(argv, fromFlag.deps), 0, fromFlag.err.join("\n"));
  assert.match(dataHostCalls(fromFlag.mt.calls)[0]!.url, /^https:\/\/other\.example\/arcgis\//);

  const empty = makeEnvCli({ REGIONALATLAS_BASE_URL: "" });
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], empty.deps), 0, empty.err.join("\n"));
  assert.match(dataHostCalls(empty.mt.calls)[0]!.url, /^https:\/\/www\.gis-idmz\.nrw\.de\//);
});

test("a bad REGIONALATLAS_BASE_URL is a usage error naming the variable, not its value", async () => {
  const cli = makeEnvCli({ REGIONALATLAS_BASE_URL: "ftp://alice:s3cret@mirror.example" });
  assert.equal(await run(["themes"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
  const err = cli.err.join("\n");
  assert.match(err, /REGIONALATLAS_BASE_URL/);
  assert.ok(!err.includes("s3cret") && !err.includes("ftp://"), err);
});

test("a password in REGIONALATLAS_BASE_URL never reaches the output, help included", async () => {
  const cli = makeEnvCli({ REGIONALATLAS_BASE_URL: "https://alice:s3cret@mirror.example" });
  assert.equal(await run(["--help"], cli.deps), 0);
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020"], cli.deps), 0);
  assert.equal(await run(["query", "NOPE"], cli.deps), 2);
  const all = [...cli.out, ...cli.err].join("\n");
  assert.match(all, /REGIONALATLAS_BASE_URL/);
  assert.ok(!all.includes("s3cret"), all);
});

// ---- P20 for the second URL: the catalogue ----

test("a plain-http: catalogue URL warns once per run, naming its token without printing it", async () => {
  const token = "tok-S3CRET-value_42";
  for (const [argv, expected] of [
    [["--catalog-url", "http://cat.example/services.json", "themes"], ["WARN  [regionalatlas.http] requests to cat.example are sent unencrypted (http:, not https:)"]],
    [["--catalog-url", `http://cat.example/s.json?token=${token}`, "indicators"], ["WARN  [regionalatlas.http] the catalogue URL's token is sent unencrypted to cat.example (http:, not https:)"]],
    [["--catalog-url", `http://u:p@cat.example:8080/s.json?token=${token}`, "themes"], ["WARN  [regionalatlas.http] the catalogue URL's token and the catalogue URL's credentials are sent unencrypted to cat.example:8080 (http:, not https:)"]],
    // themes and indicators never contact the data host: its http: base URL is not named.
    [["--base-url", "http://data.example", "themes"], []],
    // query contacts both: one warning per URL.
    [["--catalog-url", "http://cat.example/s.json", "--base-url", "http://data.example", "query", "AI002-1-5", "--year", "2020"],
      ["WARN  [regionalatlas.http] requests to cat.example are sent unencrypted (http:, not https:)", "WARN  [regionalatlas.http] requests to data.example are sent unencrypted (http:, not https:)"]],
    [["--catalog-url", "http://localhost:9/s.json", "themes"], []],
  ] as const) {
    const cli = makeCli((req) => (new URL(req.url).hostname === "data.example" ? jsonResponse(fx.landData) : jsonResponse(fx.catalog)));
    assert.equal(await run([...argv], cli.deps), 0, cli.err.join("\n"));
    assert.deepEqual(cli.err.map(untimed).filter((l) => l.startsWith("WARN ")), expected, argv.join(" "));
    assert.ok(![...cli.out, ...cli.err].join("\n").includes(token));
  }
});

test("a catalogue with colliding codes fails every command (exit 1), before any data request", async () => {
  const bad = [{ title: "T", children: [
    { code: "DUP-1", title_short: "a", years: { "2020": [] } },
    { code: "dup_1", title_short: "b", years: { "2020": [] } },
  ] }];
  for (const argv of [["themes"], ["indicators"], ["query", "dup_1", "--year", "2020"]]) {
    const cli = makeCli((req) => (new URL(req.url).hostname.includes("statistikportal") ? jsonResponse(bad) : jsonResponse(fx.landData)));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.match(cli.err.join("\n"), /Refusing the indicator catalogue: the codes "DUP-1" and "dup_1" name the same table dup_1/);
    assert.equal(dataCalls(cli.mt.calls).length, 0);
  }
});

test("an option-shaped value is quoted at most 500 characters long (L3)", async () => {
  const cli = makeRoutingCli();
  // commander echoes the whole value itself (the record's cap bounds that); the CLI's own
  // message quotes it cut.
  assert.equal(await run(["indicators", "--search", `--${"x".repeat(1500)}`], cli.deps), 2);
  const record = cli.err.find((line) => line.includes("looks like a missing value")) ?? "";
  const own = record.slice(record.indexOf("looks like a missing value"));
  assert.match(own, /^looks like a missing value — "--x+…" is the next option/);
  assert.ok(own.length < 800, `${own.length}`);
});

test("an a:b@c argument is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  // --search, --region and the indicator used to be logged as `"***@x"`, and a theme
  // title equal to a --user-agent of that shape was rewritten on stdout.
  const search = makeRoutingCli();
  assert.equal(await run(["indicators", "--search", "Bev:2024@x"], search.deps), 0);
  assert.match(untimed(search.err.join("\n")), /--search "Bev:2024@x"/);

  const region = makeRoutingCli();
  assert.equal(await run(["query", "AI002-1-5", "--year", "2020", "--region", "Nieder:sachsen@land"], region.deps), 0);
  assert.match(untimed(region.err.join("\n")), /--region "Nieder:sachsen@land"/);

  const indicator = makeRoutingCli();
  assert.equal(await run(["query", "AI002:1@5"], indicator.deps), 2);
  assert.match(untimed(indicator.err.join("\n")), /Unknown indicator "AI002:1@5"/);

  const catalog = [{ title: "run:2026-10-09@x", children: fx.catalog[0]!.children }];
  const ua = makeCli(routeByHost(catalog, fx.landData));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "themes"], ua.deps), 0);
  assert.match(ua.out.join("\n"), /"title": "run:2026-10-09@x"/);

  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("a base or catalogue URL typed without its scheme is still a credential (L14)", async () => {
  for (const argv of [
    ["--base-url", "alice:S3cret-pw@mirror.example", "query", "AI002-1-5"],
    ["--catalog-url=alice:S3cret-pw@mirror.example/services.json", "themes"],
  ]) {
    const cli = makeRoutingCli();
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    const all = [...cli.out, ...cli.err].join("\n");
    assert.ok(!all.includes("S3cret-pw"), all);
  }
});

test("a parse error is logged in the format commander would have parsed (L6)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  const cases: [string[], boolean][] = [
    // forbidRepeatedOptions keeps the first --log-format and rejects the second.
    [["--log-format", "jsonl", "--log-format", "text", "themes"], true],
    [["--log-format", "text", "--log-format", "jsonl", "themes"], false],
    // --log-format is --user-agent's value; "jsonl" is then an unknown command.
    [["--user-agent", "--log-format", "jsonl", "themes"], false],
    // commander takes the program's --log-format out first; --region is left without its value.
    [["query", "AI002-1-5", "--region", "--log-format", "jsonl"], true],
  ];
  for (const [argv, jsonl] of cases) {
    const cli = makeRoutingCli();
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.ok(cli.err.length > 0 && cli.err.every((line) => isJsonl(line) === jsonl), `${argv.join(" ")}:\n${cli.err.join("\n")}`);
  }
});

test("a malformed catalogue is an ERROR record of regionalatlas.api, exit 1 (L9)", async () => {
  const duplicate = [{ title: "T", children: [{ code: "DUP-1", years: { "2020": [] } }, { code: "dup_1", years: { "2020": [] } }] }];
  for (const body of [rawResponse("<html>login</html>", "application/json"), rawResponse("{}", "application/json"), rawResponse("[]", "application/json; charset=x-unknown"), jsonResponse(duplicate)]) {
    const cli = makeCli((req) => (new URL(req.url).hostname.includes("statistikportal") ? body : jsonResponse(fx.landData)));
    assert.equal(await run(["themes"], cli.deps), 1, body.body.toString());
    assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[regionalatlas\.api\] /, cli.err.join("\n"));
  }
});
