import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  baseUrlProblem,
  fieldsProblem,
  httpUrlProblem,
  isBlank,
  nonEmptyProblem,
  yearProblem,
  YEAR_SHAPE,
  type Problem,
} from "../src/client/validate.js";
import { filterIndicators, normaliseYearFilter, parseIndicators } from "../src/client/catalog.js";
import { filterByRegion } from "../src/client/client.js";
import { RegionalatlasError, RegionalatlasValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { makeMockTransport, parity, routeByHost, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const notFoo: Problem<string> = (v) => (v === "foo" ? "Must not be foo." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("thing", "bar", notFoo), "bar");
});

test("assertValid throws RegionalatlasValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("thing", "foo", notFoo),
    (err: unknown) => {
      assert.ok(err instanceof RegionalatlasValidationError);
      assert.ok(err instanceof RegionalatlasError);
      assert.equal((err as Error).name, "RegionalatlasValidationError");
      assert.equal((err as Error).message, "Invalid thing: Must not be foo.");
      return true;
    },
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.RegionalatlasValidationError, RegionalatlasValidationError);
  assert.equal(lib.assertValid, assertValid);
});

function cliWith(createClient: CliDeps["createClient"]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, createClient };
  return { deps, out, err };
}

test("run() maps a RegionalatlasValidationError from an action to the usage exit code 2 and an ERROR record", async () => {
  const mt = makeMockTransport(routeByHost(fx.catalog, fx.landData));
  const cli = cliWith((opts) => {
    const client = new RegionalatlasClient({ ...opts, transport: mt.transport });
    client.themes = async () => {
      throw new RegionalatlasValidationError("Invalid theme: Expected a non-empty value.");
    };
    return client;
  });
  const code = await run(["themes"], cli.deps);
  assert.equal(code, 2);
  assert.deepEqual(cli.out, []);
  assert.equal(untimed(cli.err.join("\n")), "ERROR [regionalatlas.cli] Invalid theme: Expected a non-empty value.");
  assert.equal(mt.calls.length, 0);
});

test("run() maps a RegionalatlasValidationError thrown while building the client the same way", async () => {
  const cli = cliWith(() => {
    throw new RegionalatlasValidationError("Invalid userAgent: Expected a non-empty value.");
  });
  assert.equal(await run(["themes"], cli.deps), 2);
  assert.equal(untimed(cli.err.join("\n")), "ERROR [regionalatlas.cli] Invalid userAgent: Expected a non-empty value.");
});

test("parity() drives the same input through run() and the library on one transport", async () => {
  const { cli, lib: res } = await parity(
    ["--compact", "themes"],
    (transport) => new RegionalatlasClient({ transport }).themes(),
    routeByHost(fx.catalog, fx.landData),
  );
  assert.equal(cli.code, 0);
  assert.ok(res.ok);
  assert.equal(cli.out, JSON.stringify(res.value));
  assert.deepEqual(cli.requests.map((r) => r.url), res.requests.map((r) => r.url));
});

test("isBlank / nonEmptyProblem: empty and whitespace-only strings are blank", () => {
  for (const v of ["", " ", "   ", "\t", "\n", " \t\n "]) {
    assert.equal(isBlank(v), true, JSON.stringify(v));
    assert.equal(nonEmptyProblem(v), "Expected a non-empty value.", JSON.stringify(v));
  }
  for (const v of ["a", " a ", "-1-5", "Bremen"]) {
    assert.equal(isBlank(v), false, JSON.stringify(v));
    assert.equal(nonEmptyProblem(v), undefined, JSON.stringify(v));
  }
  assert.equal(nonEmptyProblem(undefined), "Expected a non-empty value.");
  assert.equal(nonEmptyProblem(42), "Expected a non-empty value.");
});

test("fieldsProblem: a field list needs at least one non-blank name", () => {
  const reason = "Expected a comma-separated list of field names.";
  for (const v of [[], [""], [" "], ["", " ", "\t"], "ai0201", [42], ["ai0201", 42], undefined]) {
    assert.equal(fieldsProblem(v), reason, JSON.stringify(v));
  }
  for (const v of [["ai0201"], ["ai0201", " "], ["", "AI-Z01"]]) {
    assert.equal(fieldsProblem(v), undefined, JSON.stringify(v));
  }
});

test("filterIndicators and filterByRegion refuse a blank filter instead of skipping it", () => {
  const all = parseIndicators(fx.catalog);
  for (const filter of [{ theme: "" }, { theme: "  " }, { search: "" }, { search: "\t" }]) {
    assert.throws(() => filterIndicators(all, filter), RegionalatlasValidationError, JSON.stringify(filter));
  }
  assert.throws(() => filterByRegion([], "   "), /^RegionalatlasValidationError: Invalid region: Expected a non-empty value\.$/);
  assert.deepEqual(filterByRegion([], "Bremen"), []);
});

test("yearProblem / normaliseYearFilter: a 4-digit year, as a number or an unpadded string", () => {
  const reason = "Expected a 4-digit year (e.g. 2020).";
  for (const v of [2020, "2020", 1000, "9999"]) assert.equal(yearProblem(v), undefined, String(v));
  for (const v of ["", "  ", " 2020", "2020 ", "02020", "0999", 999, 20, 0, -1, 1.5, Number.NaN, Infinity, "0x10", 10000, null, undefined, [2020]]) {
    assert.equal(yearProblem(v), reason, JSON.stringify(v));
  }
  assert.equal(normaliseYearFilter(2020), "2020");
  assert.equal(normaliseYearFilter("2024"), "2024");
  assert.throws(() => normaliseYearFilter(" 2020"), /^RegionalatlasValidationError: Invalid year: Expected a 4-digit year/);
  assert.ok(YEAR_SHAPE.test("2020") && !YEAR_SHAPE.test("0999"));
  assert.equal(lib.YEAR_SHAPE, YEAR_SHAPE);
  assert.equal(lib.normaliseYearFilter, normaliseYearFilter);
});

test("httpUrlProblem / baseUrlProblem: the URL rules, in order", () => {
  assert.equal(httpUrlProblem("https://c.test/services.json?v=1"), undefined);
  assert.equal(baseUrlProblem("https://u:pw@h.test/mirror/"), undefined);
  assert.equal(httpUrlProblem(""), "Expected a non-empty value.");
  assert.equal(httpUrlProblem(" https://c.test"), "A URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("https://h.test "), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("https://h.test/a\nb"), "A base URL cannot contain whitespace or control characters.");
  assert.equal(httpUrlProblem("https://c.test/a b"), "A URL cannot contain whitespace or control characters.");
  assert.equal(httpUrlProblem("nourl"), "Expected a valid URL (e.g. https://host/path).");
  assert.equal(httpUrlProblem("ftp://h"), "Only http: and https: URLs are supported.");
  assert.equal(httpUrlProblem("https://c.test/?q=1#x"), undefined);
  assert.equal(baseUrlProblem("https://h/?q=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(httpUrlProblem(42), "Expected a non-empty value.");
});
