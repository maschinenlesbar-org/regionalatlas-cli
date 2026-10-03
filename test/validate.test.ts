import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { RegionalatlasError, RegionalatlasValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { makeMockTransport, parity, routeByHost } from "./helpers.js";
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

test("run() maps a RegionalatlasValidationError from an action to the usage exit code 2 with 'Error: <message>'", async () => {
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
  assert.equal(cli.err.join("\n"), "Error: Invalid theme: Expected a non-empty value.");
  assert.equal(mt.calls.length, 0);
});

test("run() maps a RegionalatlasValidationError thrown while building the client the same way", async () => {
  const cli = cliWith(() => {
    throw new RegionalatlasValidationError("Invalid userAgent: Expected a non-empty value.");
  });
  assert.equal(await run(["themes"], cli.deps), 2);
  assert.equal(cli.err.join("\n"), "Error: Invalid userAgent: Expected a non-empty value.");
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
