// handleOutputErrors: the write errors that mean "the reader has gone" (EPIPE, and ENOTCONN
// when stdout is a socket, as with a Node parent's piped stdio on macOS) end a run quietly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleOutputErrors } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function streams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, records };
}

test("another stdout write error is an ERROR record of regionalatlas.output, in the run's format, and exits 1", () => {
  const s = streams();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "regionalatlas.output", msg: "Could not write to stdout: write EBADF" },
  ]);
});

for (const code of ["EPIPE", "ENOTCONN"]) {
  test(`${code} on stdout exits 0; on stderr it is ignored`, () => {
    const s = streams();
    s.stderr.emit("error", writeError(code));
    assert.deepEqual(s.exits, []);
    s.stdout.emit("error", writeError(code));
    assert.deepEqual(s.exits, [0]);
  });
}

test("another stderr write error exits 1", () => {
  const s = streams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});
