// Rendering the JSON result (renderJson in src/cli/shared.ts): a deep answer printed (or
// refused) cleanly, --compact's stringify path, and the characters a terminal acts on escaped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { stdoutWriter, type CliDeps } from "../src/cli/io.js";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regionalatlas-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const answer = { title: "x", deep: nested(200_000) };
  let compactPrints = true;
  try {
    JSON.stringify(answer);
  } catch {
    compactPrints = false;
  }
  const pretty = makeCli(answer);
  assert.equal(await run(["themes"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.deepEqual(pretty.err, [
    `ERROR [regionalatlas.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(answer);
  assert.equal(await run(["--compact", "themes"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.deepEqual(compact.err, ["ERROR [regionalatlas.output] The answer is nested too deeply to print."]);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(undefined);
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
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

test("printed JSON escapes DEL, C1 and the bidi controls, which a terminal acts on", async () => {
  // JSON.stringify leaves them raw; U+202E (RLO) reverses the text that follows on screen.
  const bidi = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
  for (const compact of [false, true]) {
    const cli = makeCli([{ title: `a\u007fb\u0085c\u009b${bidi.join("")}ü€`, indicatorCount: 1 }]);
    assert.equal(await run(compact ? ["--compact", "themes"] : ["themes"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.match(text, /a\\u007fb\\u0085c\\u009b\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069ü€/);
    assert.equal(JSON.parse(text)[0].title, `a\u007fb\u0085c\u009b${bidi.join("")}ü€`);
  }
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(undefined);
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
    // Not a file (a pipe, a terminal): the stream writes it, as before.
    const piped: string[] = [];
    stdoutWriter({ write: (text: string) => piped.push(text), emit: () => true })("data");
    assert.deepEqual(piped, ["data"]);
  });
});
