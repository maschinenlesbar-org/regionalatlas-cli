// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the credentials of a URL with `***`, so a credential in a base or catalogue URL
 * never reaches an error message, a log or CI output: the userinfo
 * (`https://user:secret@host/...` becomes `https://***@host/...`) and the value of a
 * secret query parameter ({@link SECRET_QUERY_PARAMETERS}: `?token=abc` becomes
 * `?token=***`). A value that does not parse as a URL has its userinfo cut out by text
 * (`credentialsIn`); a value without credentials is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactQueryTokens(redactCredentials(url, credentialsIn(url)));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") {
    return redactQueryTokens(redactCredentials(url, credentialsIn(url)));
  }
  parsed.username = "***";
  parsed.password = "";
  return redactQueryTokens(parsed.href);
}

/**
 * The query parameters whose value is a credential: ArcGIS's `token` (the token its
 * `generateToken` endpoint issues for a secured service, sent as `?token=…`) and OAuth 2's
 * `access_token` (RFC 6750). Only the catalogue URL can carry one — a base URL takes no
 * query. Names match case-insensitively.
 */
export const SECRET_QUERY_PARAMETERS: readonly string[] = ["token", "access_token"];

/** `?token=` / `&access_token=` and the value after it (up to the next `&`, `#`, quote or space). */
const SECRET_QUERY_PARAMETER = /([?&](?:token|access_token)=)([^&#\s'"]+)/gi;

/**
 * A bare token value shorter than this is not scrubbed from free text: replacing every
 * "5" of a message for a one-character token would garble it. Its `token=` form is
 * always redacted.
 */
const MIN_BARE_TOKEN_LENGTH = 6;

/**
 * The values of the secret query parameters ({@link SECRET_QUERY_PARAMETERS}) in a
 * URL-like value, exactly as written (percent-encoded), or `[]` when it carries none. Works
 * on values that don't parse as a URL, and on values with a prefix (`--catalog-url=…`).
 */
export function queryTokensIn(value: string): string[] {
  return [...value.matchAll(SECRET_QUERY_PARAMETER)].map((m) => m[2] ?? "").filter((v) => v !== "");
}

/**
 * `text` with the value of every secret query parameter replaced by `***`
 * (`?token=abc` → `?token=***`), and every listed token value (as `queryTokensIn` returns
 * them, or decoded) replaced wherever it occurs alone — a server's "invalid token abc"
 * echoes it without the parameter name. Values shorter than six characters are only
 * redacted in their `token=` form.
 */
export function redactQueryTokens(text: string, tokens: readonly string[] = []): string {
  let out = text.replace(SECRET_QUERY_PARAMETER, (_match, head: string) => `${head}***`);
  for (const token of tokens) {
    if (token.length >= MIN_BARE_TOKEN_LENGTH) out = out.split(token).join("***");
  }
  return out;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the escaped forms of each credential, as its messages escape values.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A
 * 20 000-character indicator argument or a 200 kB server `detail` would otherwise put the
 * whole thing on one stderr line.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters, ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${text.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/** Longest query-parameter value an error message shows; a longer one becomes `…`. */
const MAX_SHOWN_PARAM_LENGTH = 60;

/**
 * The URL as an error message shows it: every query-parameter value longer than
 * `MAX_SHOWN_PARAM_LENGTH` characters (as sent, percent-encoded) is replaced by
 * `…`. The data query's `layer` parameter carries the whole SQL join as
 * URL-encoded JSON (about 750 characters), which pushed the actual reason to the
 * end of an 800-character line. The error's `url` field keeps the full URL.
 */
export function shortenUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = url
    .slice(q + 1)
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq >= 0 && part.length - eq - 1 > MAX_SHOWN_PARAM_LENGTH ? `${part.slice(0, eq)}=…` : part;
    });
  return `${url.slice(0, q)}?${params.join("&")}`;
}

/** Base class for every error originating from this client. */
export class RegionalatlasError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API signalled a failure. The Regionalatlas ArcGIS MapServer is unusual: it
 * answers HTTP 200 even for logical errors, carrying the message in an `error`
 * object (`{code, message, details}`) — e.g. a malformed query or an invalid
 * parameter. This error models both worlds:
 *  - `status` is set for a genuine transport/HTTP failure (non-2xx);
 *  - `arcgisCode` is set for a logical ArcGIS error (from `error.code`).
 * `detail` holds the human-readable message in either case.
 */
export class RegionalatlasApiError extends RegionalatlasError {
  readonly status: number | undefined;
  readonly arcgisCode: number | undefined;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    url: string;
    method: string;
    body: string;
    status?: number;
    arcgisCode?: number;
    detail?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    const head =
      args.status !== undefined
        ? `HTTP ${args.status}`
        : `ArcGIS error${args.arcgisCode !== undefined ? ` ${args.arcgisCode}` : ""}`;
    super(`${head} for ${args.method} ${shortenUrl(url)}${detailPart}`);
    this.status = args.status;
    this.arcgisCode = args.arcgisCode;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for HTTP statuses the API treats as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class RegionalatlasNetworkError extends RegionalatlasError {}

/** Which download a size-limit error is about: the indicator catalogue or a data query. */
export type Download = "catalogue" | "data";

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number, download?: Download): string {
  const what = download === "catalogue" ? "The indicator catalogue" : "Response";
  return `${what} exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * A response body over `maxResponseBytes` (a `RegionalatlasNetworkError`, exit 6 on the
 * CLI). `download` says which one, so the advice can fit: the catalogue (about 2 MB) only
 * gets smaller with a higher limit, a data reply also with a coarser level. It is
 * `undefined` when a transport raised the error outside the engine.
 */
export class RegionalatlasSizeLimitError extends RegionalatlasNetworkError {
  readonly limit: number;
  readonly download: Download | undefined;

  constructor(limit: number, download?: Download, options?: { cause?: unknown }) {
    super(sizeLimitMessage(limit, download), options);
    this.limit = limit;
    this.download = download;
  }
}

/**
 * A client-side validation / not-found error made before any request — e.g. an
 * unknown indicator code, an unknown geo level, or a year outside an indicator's
 * available range. Crucially, the indicator/level/year values that enter the raw
 * SQL query are all validated against the catalogue here, so a rejected value
 * never reaches the transport. `assertValid` (validate.ts) throws it with the
 * message `Invalid <name>: <reason>`. The CLI maps it to its usage-error exit
 * code (2).
 */
export class RegionalatlasValidationError extends RegionalatlasError {}

/** The response body could not be parsed as the expected JSON shape. */
export class RegionalatlasParseError extends RegionalatlasError {}
