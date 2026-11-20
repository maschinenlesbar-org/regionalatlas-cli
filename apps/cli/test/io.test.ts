// The process-signal seam of src/cli/io.ts, on a fake process: no process is started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { exitOnSignalsAsPid1 } from "../src/cli/io.js";

/** A process stand-in with a pid: records its signal listeners and exits. */
function fakeProcess(pid: number) {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return { emitter, exits, proc: { pid, once: (event: string, listener: () => void) => emitter.once(event, listener), exit: (code: number) => void exits.push(code) } };
}

test("as PID 1 (a container's first process), SIGINT, SIGTERM and SIGHUP exit 130, 143 and 129: the kernel drops a default-action signal sent to PID 1", () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const { emitter, exits, proc } = fakeProcess(1);
    exitOnSignalsAsPid1(proc);
    emitter.emit(signal);
    assert.deepEqual(exits, [code], signal);
  }
});

test("not PID 1, no signal listener is installed: Node's default action stays", () => {
  const { emitter, proc } = fakeProcess(4242);
  exitOnSignalsAsPid1(proc);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(emitter.listenerCount(signal), 0, signal);
});
