// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503) — honouring
// Retry-After when the server sends one — and decodes JSON responses. The Regionalatlas is backed by an ArcGIS MapServer — an
// unauthenticated GET API whose parameters travel in the query string.
//
// Two-host note: the *data* queries hit the ArcGIS MapServer (`baseUrl`, default
// the gis-idmz.nrw.de host), while the *indicator catalogue* is a static JSON file
// on the statistikportal.de host. The engine therefore also supports GETting a
// fully-qualified absolute URL (`requestAbsolute`) so the catalogue can be fetched
// without changing the data `baseUrl`.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  RegionalatlasApiError,
  RegionalatlasError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
  RegionalatlasSizeLimitError,
  RegionalatlasValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  type Download,
  echoedCredentialForms,
  queryTokensIn,
  redactCredentials,
  redactQueryTokens,
  redactSecrets,
  redactUrl,
  retriedSuffix,
} from "./errors.js";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  httpUrlProblem,
} from "./validate.js";

/** The ArcGIS MapServer host that answers the dynamicLayer data queries. */
export const DEFAULT_BASE_URL = "https://www.gis-idmz.nrw.de";
const DEFAULT_USER_AGENT = "regionalatlas-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a
 * RegionalatlasValidationError.
 */
export interface EngineOptions {
  /** Base URL of the ArcGIS data host. Defaults to the gis-idmz.nrw.de MapServer host. */
  baseUrl?: string;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in
   * any case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and
   * turns whatever it throws into a `RegionalatlasNetworkError`.
   */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most MAX_TIMEOUT_MS, 2^31 - 1 ms). Enforced by the
   * engine for every transport (the request's `signal` aborts then).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `UND_ERR_SOCKET`, …), 0..`MAX_RETRIES` (10). A refused connection, a
   * DNS failure and a timeout are not retried.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), at most
   * `MAX_RETRY_AFTER_MS`. A `Retry-After` can make a wait longer, never shorter.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most `Number.MAX_SAFE_INTEGER`. The default transport aborts as soon as the cap
   * is passed; the engine also checks the body any transport returns.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: (event: RetryEvent) => void;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo (and a catalogue token) redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in a response — the ArcGIS `error` detail, the
 * non-JSON body snippet, and every text of the catalogue (titles, units, theme
 * names), which reach stderr in error messages — safe to print:
 *
 * - C0 and C1 controls and DEL are dropped. `JSON.parse` decodes an escaped ESC (a
 *   backslash-u-001b sequence) into a real ESC byte; printed raw, a hostile or
 *   MITM'd host could drive ANSI/OSC sequences into the terminal (screen clears,
 *   title changes, output spoofing).
 * - Bidi formatting characters (`isBidiControl`) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and cannot forge
 *   a log record of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts). Written as a char-code filter so no raw control byte appears in
 * this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The human-readable text of an ArcGIS `error` value, for an error message: a bare
 * string as is, or an `{code, message, details}` object's `message` and `details`
 * joined with "; ". Empty parts and repeats are dropped (the server can send
 * `"message": ""` with the reason only in `details`, or the same text in both).
 * Every part goes through `sanitizeServerText`. Returns `undefined` when nothing
 * readable is left.
 */
export function describeArcGisError(error: unknown): string | undefined {
  let parts: unknown[] = [];
  if (typeof error === "string") parts = [error];
  else if (error !== null && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown };
    parts = [e.message, ...(Array.isArray(e.details) ? e.details : [])];
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const text = sanitizeServerText(part);
    if (text !== "") seen.add(text);
  }
  return seen.size > 0 ? [...seen].join("; ") : undefined;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` in any case: the engine then saw no Retry-After and
 * backed off 200 ms instead of the server's wait. Such an object (anything with `get`
 * and `forEach`, a `Headers` or a `Map`) is copied into a record; a plain record gets its
 * names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -5` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    // A string is quoted, so `"5000"` doesn't read as the number it isn't.
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new RegionalatlasValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${cutForMessage(shown)}.`,
    );
  }
  return value;
}

/** A function option (`transport`, `sleep`): `undefined` gives the default; anything else must be a function. */
function functionOption<T>(name: string, value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new RegionalatlasValidationError(`Invalid option ${name}: expected a function, got ${typeof value}.`);
  }
  return value;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upper bound on a honoured `Retry-After`. The header is server-controlled, and a
 * `Retry-After: 86400` would otherwise park the CLI for a day, so a longer wait is
 * clamped to this.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-5"`),
 * fractional (`"1.5"`), any other date format — so the caller falls back to linear
 * backoff. The strict patterns matter: `Date.parse` alone reads `"1.5"`, `"-5"` and
 * `"0.5"` as dates in 2000/2001 and so retried at once, in a burst.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Reject a request URL whose scheme is not http/https, before it reaches the
 * transport. Defence-in-depth for library consumers who inject a custom Transport
 * (the CLI and the default transport already reject non-http(s) URLs).
 */
function assertHttpScheme(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new RegionalatlasNetworkError(`Invalid request URL: ${redactUrl(url)}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new RegionalatlasNetworkError(
      `Unsupported URL scheme "${protocol}" — only http and https are allowed.`,
    );
  }
}

/**
 * Check a configured URL and return it unchanged, or throw a
 * RegionalatlasValidationError (`Invalid <name>: <reason>`): blank, surrounding or
 * interior whitespace or control characters, unparsable, or not `http:`/`https:`;
 * with `base: true` also a query or fragment (`baseUrlProblem`, else
 * `httpUrlProblem`). The client checks `baseUrl` and `catalogUrl` with it when it is
 * built; the CLI's `--base-url`/`--catalog-url` parsers use the same rules.
 */
export function validateHttpUrl(name: string, value: string, options: { base?: boolean } = {}): string {
  return assertValid(name, value, options.base === true ? baseUrlProblem : httpUrlProblem);
}

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a
 * warning (without a `warning: ` prefix), or `undefined` when they would not: for
 * `https:`, for a URL that does not parse, and for a loopback host (`localhost`,
 * 127.0.0.0/8, `::1`), where nothing leaves the machine. Works for the catalogue URL
 * too.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: every phrase in `secrets` (noun phrases such as "the
 * catalogue URL's token"; the CLI passes that one when the catalogue URL carries a
 * `?token=`), and `<urlName>'s credentials` when the URL carries userinfo ("the base URL's
 * credentials" by default). It never contains a password or token. The CLI prints it
 * once per run and URL as a `WARN` record of `regionalatlas.http` on stderr.
 */
export function cleartextProblem(
  baseUrl: string,
  secrets: readonly string[] = [],
  urlName = "the base URL",
): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? [`${urlName}'s credentials`] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * Check a value bound for an HTTP header (headerValueProblem) and return it, or
 * throw a RegionalatlasValidationError
 * (`Invalid <name>: Value contains control characters.`).
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** The userinfo of a URL, as written and percent-decoded, for scrubbing text that echoes it. */
function credentialForms(url: string): string[] {
  return withDecoded(credentialsIn(url));
}

/** The secret query-parameter values of a URL (`?token=`), as written and percent-decoded. */
function queryTokenForms(url: string): string[] {
  // Also as an error message shows it: a server that echoes the token has its text
  // cleaned (sanitizeServerText drops control and bidi characters and folds whitespace)
  // before the message is redacted.
  const forms = withDecoded(queryTokensIn(url));
  return [...new Set([...forms, ...forms.map(sanitizeServerText)])].filter((form) => form !== "");
}

/** Each value as written and percent-decoded (when it decodes). */
function withDecoded(values: string[]): string[] {
  return values.flatMap((raw) => {
    try {
      return [raw, decodeURIComponent(raw)];
    } catch {
      return [raw];
    }
  });
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy cannot turn a valid answer into a
 * parse error; a Latin-1 body from a mirror is no longer misread as UTF-8
 * ("Baden-W\uFFFDrttemberg", and `--region Württemberg` then matching nothing). An
 * unknown charset label is a RegionalatlasParseError.
 */
function decodeBody(body: Buffer, contentType: string, source: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new RegionalatlasParseError(
      `Unsupported response charset "${cutText(sanitizeServerText(charset), 100)}" from ${source}.`,
    );
  }
  return decoder.decode(body);
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /**
   * The userinfo of the base URL and of every absolute URL requested (the catalogue),
   * raw and percent-decoded, for scrubbing server and transport text.
   */
  readonly #credentials = new Set<string>();
  /** The secret query-parameter values (`?token=`) of the catalogue URL, raw and decoded. */
  readonly #tokens = new Set<string>();
  /**
   * The forms a server echoes those userinfos back in (the Basic value, the decoded
   * `user:password`, the password alone): `echoedCredentialForms`.
   */
  readonly #echoed = new Set<string>();
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;

  constructor(options: EngineOptions | null = {}) {
    // A plain-JS caller's `null` counts as no options; anything else must be an object.
    if (options === null) options = {};
    if (typeof options !== "object" || Array.isArray(options)) {
      throw new RegionalatlasValidationError("Invalid options: expected an object.");
    }
    // The raw value is checked, before the trailing-slash strip: request paths are
    // appended to it as a string, so whitespace would land in the path, and a `?` or
    // `#` would swallow every path (`http://h/m?token=abc` requests
    // `/m?token=abc/arcgis/...`). Only undefined selects the default.
    const baseUrl =
      options.baseUrl === undefined ? DEFAULT_BASE_URL : validateHttpUrl("baseUrl", options.baseUrl, { base: true });
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    for (const form of credentialForms(this.#baseUrl)) this.#credentials.add(form);
    for (const form of credentialsIn(this.#baseUrl).flatMap(echoedCredentialForms)) this.#echoed.add(form);
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only undefined selects the default; a blank or unsendable value is refused
    // here rather than sent blank or failing late with Node's raw TypeError.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    const extra: unknown = options.defaultHeaders;
    if (extra !== undefined && (typeof extra !== "object" || extra === null || Array.isArray(extra))) {
      throw new RegionalatlasValidationError("Invalid option defaultHeaders: expected an object of header names and values.");
    }
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.defaultHeaders)) {
      assertValid(`header name ${JSON.stringify(name)}`, name, headerNameProblem);
      assertHeaderValue(`header ${JSON.stringify(name)}`, value);
    }
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry = options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: this.redact(redactUrl(url)),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the credentials of the base URL or of any absolute URL this engine
   * requested (the catalogue): server text (an error body that echoes the request URL) and
   * transport text (fetch's "Failed to fetch <url>") can carry them. The client uses it for
   * the errors it builds itself (the ArcGIS envelope).
   */
  redact(text: string): string {
    if (this.#credentials.size === 0 && this.#tokens.size === 0) return text;
    // Longest first, so a password never leaves half of the user:password around it.
    const echoed = [...this.#echoed].sort((a, b) => b.length - a.length);
    return redactQueryTokens(redactSecrets(redactCredentials(text, [...this.#credentials]), echoed), [...this.#tokens]);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal a password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if ((this.#credentials.size === 0 && this.#tokens.size === 0) || depth > 5) return cause;
    if (typeof cause === "string") return this.redact(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.redact(cause.message);
    const stack = cause.stack ?? "";
    if (message === cause.message && inner === cause.cause && this.redact(stack) === stack) {
      return cause;
    }
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `RegionalatlasNetworkError` only; an injected one may throw anything (a
   * string, a `TypeError` from fetch). Every failure becomes a `RegionalatlasNetworkError`
   * — a `RegionalatlasError` a caller and the CLI can rely on — with the credentials
   * scrubbed from its message and cause chain; any other `RegionalatlasError` passes
   * through, and a clean `RegionalatlasNetworkError` stays as it is.
   */
  private transportError(cause: unknown, retries = 0): RegionalatlasError {
    if (cause instanceof RegionalatlasError && !(cause instanceof RegionalatlasNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.redact(reason)) + retriedSuffix(retries);
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof RegionalatlasNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new RegionalatlasNetworkError(message, { cause: scrubbed });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new RegionalatlasNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a fully-qualified URL from a path (on the data host) and optional query. The
   * result carries the base URL's userinfo, if any: it is the URL a transport requests.
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Build a fully-qualified URL from an absolute base URL and optional query. */
  buildAbsoluteUrl(absoluteUrl: string, query?: QueryParams): string {
    const qs = query ? buildQueryString(query) : "";
    if (!qs) return absoluteUrl;
    return absoluteUrl.includes("?") ? `${absoluteUrl}&${qs}` : `${absoluteUrl}?${qs}`;
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — the canonical host answers directly, so a 3xx surfaces as
   * an error.
   */
  private async requestUrl(url: string, accept: string, download: Download): Promise<RawResponse> {
    // Enforce http(s) at the engine boundary too. The CLI validates
    // --base-url/--catalog-url at parse time and the default transport re-checks,
    // but a library consumer injecting a custom Transport would otherwise inherit no
    // scheme guard. This covers both the data host and the absolute catalogue URL.
    assertHttpScheme(url);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method: "GET",
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        // Say which download was too big (the transport doesn't know).
        if (cause instanceof RegionalatlasSizeLimitError && cause.download === undefined) {
          throw new RegionalatlasSizeLimitError(cause.limit, download, { cause });
        }
        throw this.transportError(cause, hasTransientCode(cause) ? attempt : 0);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the RegionalatlasError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new RegionalatlasNetworkError(`The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new RegionalatlasSizeLimitError(this.maxResponseBytes, download);
      }
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly (retryDelayMs * attempt). A Retry-After header (delta-seconds
        // or HTTP-date) can make the wait longer, never shorter: `Retry-After: 0` or a date
        // in the past turned the retries into a zero-delay burst against a server that had
        // just asked for less load. A longer one is clamped to MAX_RETRY_AFTER_MS.
        const backoff = this.retryDelayMs * attempt;
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        await this.backOff(
          attempt,
          retryAfter === undefined ? backoff : Math.max(Math.min(retryAfter, MAX_RETRY_AFTER_MS), backoff),
          url,
          status,
        );
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        // A 429/503 that is still there after the retries says so ("retried n times").
        throw this.toApiError(url, status, body, retryable ? attempt : 0);
      }

      return { data: body, contentType, status };
    }
  }

  /** GET a path on the data host with query params. */
  async request(path: string, query?: QueryParams, accept = "application/json"): Promise<RawResponse> {
    return this.requestUrl(this.buildUrl(path, query), accept, "data");
  }

  /** GET a path on the data host and parse the JSON reply into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    return this.decodeJson<T>(await this.request(path, query), path);
  }

  /** GET a fully-qualified absolute URL (e.g. the catalogue host) and parse JSON into `T`. */
  async getJsonAbsolute<T>(absoluteUrl: string, query?: QueryParams): Promise<T> {
    const url = this.buildAbsoluteUrl(absoluteUrl, query);
    // Its userinfo is as secret as the base URL's, and so is a `?token=`: scrub both from
    // every message too.
    for (const form of credentialForms(url)) this.#credentials.add(form);
    for (const form of credentialsIn(url).flatMap(echoedCredentialForms)) this.#echoed.add(form);
    for (const form of queryTokenForms(url)) this.#tokens.add(form);
    return this.decodeJson<T>(await this.requestUrl(url, "application/json", "catalogue"), redactUrl(url));
  }

  /** Parse a JSON body; `source` names it in the error (a path, or a redacted URL). */
  private decodeJson<T>(res: RawResponse, source: string): T {
    const text = decodeBody(res.data, res.contentType, this.redact(source));
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new RegionalatlasParseError(`Failed to parse JSON response from ${this.redact(source)}`, {
        cause: this.scrubCause(cause),
      });
    }
  }

  private toApiError(url: string, status: number, body: Buffer, retries = 0): RegionalatlasApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.redact(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      const arcgis = parsed?.error ? describeArcGisError(parsed.error) : undefined;
      if (arcgis !== undefined) detail = arcgis;
      else if (typeof parsed?.message === "string") detail = parsed.message;
      else if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Not JSON (e.g. an HTML error page). Surface a short, whitespace-collapsed
      // snippet of a textual body; skip HTML pages (start with "<").
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > 200 ? `${cutText(snippet, 200)}…` : snippet;
      }
    }
    // `detail` came from the attacker-controlled response body; strip control
    // characters so a hostile endpoint cannot drive terminal escape sequences
    // into stderr via the error message.
    // Cut, too: a server can send a 200 kB detail.
    // Redacted again once cleaned: cleaning can turn an echoed token into its cleaned form.
    if (detail !== undefined) detail = cutForMessage(this.redact(sanitizeServerText(detail)));
    return new RegionalatlasApiError({ status, url, method: "GET", body: text, detail, retries });
  }
}
