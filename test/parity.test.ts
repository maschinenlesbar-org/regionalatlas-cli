// CLI ↔ library parity: the same input through run() and through the library
// call the CLI makes, on one recording mock transport, must give the same outcome
// — both reject before any request, or both send the identical requests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RegionalatlasClient } from "../src/client/client.js";
import { RegionalatlasValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import * as lib from "../src/index.js";
import { parity, requestShapes, routeByHost } from "./helpers.js";
import * as fx from "./fixtures.js";

const client = (transport: Transport) => new RegionalatlasClient({ transport });
const routes = routeByHost(fx.catalog, fx.landData);

/** Both sides reject the input with exit 2 / a RegionalatlasValidationError, and neither sends a request. */
async function assertBothReject(
  argv: string[],
  call: (transport: Transport) => unknown,
  message: RegExp,
): Promise<void> {
  const { cli, lib } = await parity(argv, call, routes);
  const label = JSON.stringify(argv);
  assert.equal(cli.code, 2, `${label}: CLI exit code`);
  assert.equal(cli.requests.length, 0, `${label}: CLI sent a request`);
  assert.equal(lib.ok, false, `${label}: library accepted the input`);
  if (!lib.ok) {
    assert.ok(lib.error instanceof RegionalatlasValidationError, `${label}: ${String(lib.error)}`);
    assert.match((lib.error as Error).message, message, label);
  }
  assert.equal(lib.requests.length, 0, `${label}: library sent a request`);
}

/** Both sides succeed, send the identical requests, and the CLI prints what the library returned. */
async function assertSameResult(argv: string[], call: (transport: Transport) => unknown): Promise<void> {
  const { cli, lib } = await parity(["--compact", ...argv], call, routes);
  const label = JSON.stringify(argv);
  assert.equal(cli.code, 0, `${label}: CLI exit code (${cli.err})`);
  assert.ok(lib.ok, `${label}: library rejected the input`);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests), label);
  assert.equal(cli.out, JSON.stringify(lib.value), label);
}

// ---- Finding #1 (PAT-9): blank text filters ----

const blankFilterCases: Array<[string[], (t: Transport) => unknown, RegExp]> = [
  [["indicators", "--search", ""], (t) => client(t).indicators({ search: "" }), /^Invalid search: Expected a non-empty value\.$/],
  [["indicators", "--search", "   "], (t) => client(t).indicators({ search: "   " }), /^Invalid search: /],
  [["indicators", "--search", "\t"], (t) => client(t).indicators({ search: "\t" }), /^Invalid search: /],
  [["indicators", "--search", "\n"], (t) => client(t).indicators({ search: "\n" }), /^Invalid search: /],
  [["indicators", "--theme", ""], (t) => client(t).indicators({ theme: "" }), /^Invalid theme: Expected a non-empty value\.$/],
  [["indicators", "--theme", "  "], (t) => client(t).indicators({ theme: "  " }), /^Invalid theme: /],
  [
    ["query", "AI002-1-5", "--year", "2020", "--region", "   "],
    (t) => client(t).queryResult({ indicator: "AI002-1-5", level: "land", year: 2020, region: "   " }),
    /^Invalid region: Expected a non-empty value\.$/,
  ],
  [
    ["query", "AI002-1-5", "--year", "2020", "--region", ""],
    (t) => client(t).queryResult({ indicator: "AI002-1-5", level: "land", year: 2020, region: "" }),
    /^Invalid region: /,
  ],
  [
    ["query", "AI002-1-5", "--year", "2020", "--fields", " , "],
    (t) => client(t).queryResult({ indicator: "AI002-1-5", level: "land", year: 2020, fields: ["", " "] }),
    /^Invalid fields: Expected a comma-separated list of field names\.$/,
  ],
  [
    ["query", "AI002-1-5", "--year", "2020", "--fields", " "],
    (t) => client(t).queryResult({ indicator: "AI002-1-5", level: "land", year: 2020, fields: [" "] }),
    /^Invalid fields: /,
  ],
  [
    ["query", "AI002-1-5", "--year", "2020", "--fields", ""],
    (t) => client(t).queryResult({ indicator: "AI002-1-5", level: "land", year: 2020, fields: [""] }),
    /^Invalid fields: /,
  ],
];

for (const [argv, call, message] of blankFilterCases) {
  test(`parity: a blank filter is rejected by CLI and library alike (${JSON.stringify(argv)})`, async () => {
    await assertBothReject(argv, call, message);
  });
}

test("parity: non-blank filters give the same requests and result on both sides", async () => {
  await assertSameResult(
    ["query", "AI002-1-5", "--year", "2020", "--region", "Bremen", "--fields", "ai0201, ,"],
    (t) => client(t).query({ indicator: "AI002-1-5", level: "land", year: 2020, region: "Bremen", fields: ["ai0201", " ", ""] }),
  );
});

// ---- Finding #3 (PAT-15): the default level ----

test("parity: query without a level uses the library's DEFAULT_LEVEL on both sides", async () => {
  assert.equal(lib.DEFAULT_LEVEL, "land");
  await assertSameResult(["query", "AI002-1-5", "--year", "2020"], (t) =>
    client(t).query({ indicator: "AI002-1-5", year: 2020 }),
  );
});

test("parity: an omitted, undefined or null level is the default, not a raw TypeError", async () => {
  for (const level of [undefined, null]) {
    await assertSameResult(["query", "AI002-1-5", "--year", "2020"], (t) =>
      client(t).query({ indicator: "AI002-1-5", year: 2020, level: level as unknown as string }),
    );
  }
});

// ---- Finding #2 (PAT-17): the indicators year filter ----

const badYearCases: Array<[string, unknown]> = [
  [" 2020", " 2020"],
  ["2020 ", "2020 "],
  ["20", 20],
  ["0", 0],
  ["1.5", 1.5],
  ["02020", "02020"],
  ["0999", 999],
  ["0x10", "0x10"],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["", ""],
  ["   ", "   "],
];

for (const [arg, value] of badYearCases) {
  test(`parity: indicators --year ${JSON.stringify(arg)} is rejected by CLI and library alike`, async () => {
    await assertBothReject(
      ["indicators", "--year", arg],
      (t) => client(t).indicators({ year: value as string | number }),
      /^Invalid year: Expected a 4-digit year \(e\.g\. 2020\)\.$/,
    );
  });
}

test("parity: indicators --year 2020 filters the same on both sides (number and string)", async () => {
  for (const year of [2020, "2020"]) {
    const { cli, lib } = await parity(["--compact", "indicators", "--year", "2020"], (t) => client(t).indicators({ year }), routes);
    assert.equal(cli.code, 0);
    assert.ok(lib.ok);
    assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
    const codes = (JSON.parse(cli.out) as { code: string }[]).map((i) => i.code);
    assert.deepEqual(codes, (lib.value as { code: string }[]).map((i) => i.code));
    assert.deepEqual(codes, ["AI001-2-5", "AI002-1-5", "AI002-2-5"]);
  }
});

// ---- Finding #4 (PAT-5): User-Agent header values ----

const badUserAgents: Array<[string, RegExp]> = [
  ["", /^Invalid userAgent: Expected a non-empty value\.$/],
  ["   ", /^Invalid userAgent: Expected a non-empty value\.$/],
  ["x\r\nX-Injected: 1", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u0000b", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u007fb", /^Invalid userAgent: Value contains control characters\.$/],
  ["agentĀ", /^Invalid userAgent: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/],
  ["€", /^Invalid userAgent: Value contains characters outside Latin-1/],
];

for (const [ua, message] of badUserAgents) {
  test(`parity: --user-agent ${JSON.stringify(ua)} is rejected by CLI and library alike`, async () => {
    await assertBothReject(["--user-agent", ua, "themes"], (t) => new RegionalatlasClient({ transport: t, userAgent: ua }).themes(), message);
  });
}

test("parity: an accepted User-Agent (tab, Latin-1, padding) is sent unchanged by both sides", async () => {
  for (const ua of [" spaced ", "a\tb", "Müller"]) {
    await assertSameResult(["--user-agent", ua, "themes"], (t) => new RegionalatlasClient({ transport: t, userAgent: ua }).themes());
  }
});
