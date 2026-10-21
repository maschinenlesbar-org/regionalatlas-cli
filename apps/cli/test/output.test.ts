// Rendering the JSON result (renderJson in src/cli/shared.ts): a deep answer printed (or
// refused) cleanly, --compact's stringify path, and the characters a terminal acts on escaped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import type { CliDeps } from "../src/cli/io.js";
import type { RegionalatlasClient } from "@maschinenlesbar.org/regionalatlas-client/internal/client";
import { untimed } from "./helpers.js";

/** CLI deps whose client answers `themes` with `answer` (no transport, no request). */
function makeCli(answer: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    env: {},
    createClient: () => ({ themes: async () => answer }) as unknown as RegionalatlasClient,
  };
  return { deps, out, err };
}

/** An array nested `depth` levels deep, built without recursion. */
function nested(depth: number): unknown {
  let value: unknown = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't.
  const cli = makeCli({ title: "x", deep: nested(200_000) });
  assert.equal(await run(["themes"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err, ["ERROR [regionalatlas.output] The answer is nested too deeply to pretty-print; try --compact."]);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(undefined);
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});
