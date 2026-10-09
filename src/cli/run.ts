// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { BASE_URL_ENV, buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { stripTerminalControls } from "./shared.js";
import {
  RegionalatlasApiError,
  RegionalatlasError,
  RegionalatlasNetworkError,
  RegionalatlasSizeLimitError,
  RegionalatlasValidationError,
  credentialsIn,
  queryTokensIn,
  redactCredentials,
  redactQueryTokens,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, a
 * missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** HTTP 404 — resource not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error. */
  OTHER: 1,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo and the catalogue token of every argument replaced. */
  out(text: string): string;
  /** stderr text, a record's message: the same. */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes rejected values in its
 * errors (`option '--base-url <url>' argument '…' is invalid`), and the CLI's own
 * messages quote arguments (`Unknown indicator "…"`): whatever path a credential from
 * `--base-url`, `--catalog-url` or REGIONALATLAS_BASE_URL takes, the exact userinfo (as
 * `credentialsIn` finds it, plus its control-stripped and JSON-quoted forms) is replaced
 * by `***`. A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or
 * `/`; the exact strings can. The value of a `?token=` / `&access_token=` in an argument
 * is a credential as well (`redactQueryTokens`): its `token=` form and the bare value
 * become `***`. Without credentials in the arguments the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[], env: Record<string, string | undefined>): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const tokens = new Set<string>();
  for (const source of [...argv, ...values, env[BASE_URL_ENV] ?? ""]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(stripTerminalControls(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
    // A `?token=` in --catalog-url is a credential too (an ArcGIS token).
    for (const token of queryTokensIn(source)) {
      tokens.add(token);
      tokens.add(stripTerminalControls(token));
      tokens.add(JSON.stringify(token).slice(1, -1));
      try {
        tokens.add(decodeURIComponent(token));
      } catch {
        // not percent-decodable: the raw form is enough
      }
    }
  }
  if (secrets.size === 0 && tokens.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  const tokenList = [...tokens];
  const redact = (text: string): string =>
    redactQueryTokens(redactUserinfo(redactCredentials(text, list)), tokenList);
  return { out: redact, err: redact };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the unredacted `io.err`, so the frame is
 * never touched and a password holding DEL, C1 or bidi characters is matched before the
 * record escapes it. `io.err` itself is redacted too, for anything that writes to stderr
 * without the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv, deps.env ?? {});
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

export async function run(argv: string[], rawDeps: CliDeps = defaultDeps): Promise<number> {
  // Everything written to stderr — our messages and commander's parse errors, which
  // quote the raw argument — loses terminal control characters. stdout is left
  // alone: it carries the data as escaped JSON. Credentials from the arguments are
  // redacted from both first (withRedactedOutput); a record is redacted in its message
  // and escaped, so the strip finds nothing left to drop in it.
  const stripped: CliDeps = {
    ...rawDeps,
    io: { ...rawDeps.io, err: (text) => rawDeps.io.err(stripTerminalControls(text)) },
  };
  // The log replaces the secrets of the run in every message, in either format.
  const deps = withRedactedOutput(stripped, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    const log = logOf(deps);
    if (err instanceof RegionalatlasValidationError) {
      log.error("cli", err.message);
      return EXIT.USAGE;
    }
    if (err instanceof RegionalatlasApiError) {
      log.error("api", err.message);
      if (err.status === 404) return EXIT.NOT_FOUND;
      // A 3xx means the base URL redirected (the canonical host answers directly),
      // so it is a base-URL misconfiguration — a usage error.
      if (err.status !== undefined && err.status >= 300 && err.status < 400) return EXIT.USAGE;
      return EXIT.OTHER;
    }
    if (err instanceof RegionalatlasNetworkError) {
      log.error("http", err.message);
      if (err instanceof RegionalatlasSizeLimitError && err.download === "catalogue") {
        // themes, indicators and every query read the catalogue first; no --level helps.
        log.info(
          "http",
          "the indicator catalogue (about 2 MB) is larger than the size cap. Raise " +
            "--max-response-bytes <n> (0 = unlimited).",
        );
      } else if (/maxResponseBytes/.test(err.message)) {
        log.info(
          "http",
          "the response exceeded the size cap. Narrow the query (a coarser --level) or " +
            "raise --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof RegionalatlasError) {
      log.error("cli", err.message);
      return EXIT.OTHER;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
