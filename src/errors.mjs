/**
 * Error taxonomy and process exit codes.
 *
 * The CLI distinguishes three scripting-relevant outcomes plus a usage error:
 *
 *   0  success            — an answer was produced (with or without source links)
 *   2  no answer          — the documentation did not support a reliable answer
 *   3  operational error  — auth, network, timeout or MCP/protocol failure
 *   4  usage error        — bad arguments / empty question
 *
 * Every failure the CLI reports goes through `PharosError` so the message and the
 * remediation hint stay actionable and no raw response is dumped to the user.
 */

/** @typedef {"usage" | "auth" | "network" | "timeout" | "http" | "stream" | "mcp"} PharosErrorKind */

export const EXIT = Object.freeze({
  OK: 0,
  NO_ANSWER: 2,
  OPERATIONAL: 3,
  USAGE: 4,
});

export class PharosError extends Error {
  /**
   * @param {string} message  Short, user-facing description of what went wrong.
   * @param {{
   *   kind?: PharosErrorKind,
   *   hint?: string | null,
   *   status?: number | null,
   *   url?: string | null,
   *   code?: string | null,
   *   details?: unknown,
   *   cause?: unknown,
   * }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
    this.name = "PharosError";
    this.kind = meta.kind ?? "mcp";
    this.hint = meta.hint ?? null;
    this.status = meta.status ?? null;
    this.url = meta.url ?? null;
    this.code = meta.code ?? null;
    this.details = meta.details ?? null;
  }
}

/** Map any thrown value to a CLI exit code. */
export function exitCodeFor(err) {
  if (err instanceof PharosError && err.kind === "usage") return EXIT.USAGE;
  return EXIT.OPERATIONAL;
}

/**
 * Turn an arbitrary thrown value into a `PharosError` with an actionable hint.
 * Unknown errors are reported as generic operational failures rather than leaked.
 * @param {unknown} err
 * @param {{ url?: string | null, phase?: string }} [context]
 * @returns {PharosError}
 */
export function toPharosError(err, context = {}) {
  if (err instanceof PharosError) return err;

  const url = context.url ?? null;
  const host = hostOf(url);

  if (isAbortError(err)) {
    return new PharosError(
      `the Pharos documentation service did not finish responding in time${host ? ` (${host})` : ""}`,
      {
        kind: "timeout",
        url,
        hint: "Retry, or raise the deadline with --timeout <seconds> / PHAROS_STREAM_TIMEOUT_MS.",
        cause: err,
      },
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return new PharosError(`could not reach the Pharos documentation service${host ? ` (${host})` : ""}: ${message}`, {
    kind: "network",
    url,
    hint: "Check network connectivity, proxy/VPN settings and DNS, then retry.",
    cause: err,
  });
}

/** @param {unknown} err */
export function isAbortError(err) {
  return (
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) ||
    (typeof err === "object" && err !== null && /** @type {any} */ (err).code === "ABORT_ERR")
  );
}

/** @param {string | null | undefined} url */
export function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
