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
