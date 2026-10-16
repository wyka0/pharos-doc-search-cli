/**
 * Answer-quality policy.
 *
 * The CLI must not present a vague, empty or contradictory reply as a documentation answer.
 * This module turns one raw Docs MCP reply into one of three outcomes:
 *
 *   "ok"        — a usable answer; any `warnings` are printed alongside it
 *   "no-answer" — the service did not support a reliable answer (exit code 2)
 *   "error"     — the interaction failed operationally (exit code 3)
 *
 * The policy is intentionally conservative and *only* inspects text the service returned —
 * it never adds facts. The full decision table is documented in README.md.
 *
 * Decision order:
 *   1. a stream error frame anywhere            -> error     (partial text kept for --json/--debug)
 *   2. empty text                               -> error when the deadline hit or the stream
 *                                                  errored, otherwise no-answer
 *   3. text matches a first-person inability /
 *      "no information" phrasing                -> no-answer
 *   4. the service states the documentation does
 *      not cover the question and cited no
 *      docs.pharos.xyz page                      -> no-answer
 *   5. --require-sources and no source link      -> no-answer
 *   6. otherwise                                 -> ok (with warnings for partial answers)
 */

import { extractSources } from "./sources.mjs";

export const NO_ANSWER_MESSAGE =
  "No reliable answer found in the available Pharos documentation. Try a more specific question.";

export const NO_SOURCE_NOTE =
  "No source link was returned by the documentation service for this answer, so no reference can be shown.";

export const PARTIAL_ANSWER_NOTE =
  "This answer was cut short by the client-side stream deadline; it may be incomplete.";

export const INTERRUPTED_STREAM_NOTE =
  "The response stream ended unexpectedly (no end-of-stream frame); the answer may be incomplete.";

/** First-person inability or explicit "no information" phrasing = not an answer. */
const INSUFFICIENT_PATTERNS = [
  /\bi (?:do not|don'?t) (?:know|have)\b/i,
  /\bi (?:do not|don'?t) have (?:enough|sufficient|any|access to|that|this) (?:information|context|details?|data)?\b/i,
  /\bi (?:could not|couldn'?t|cannot|can'?t)\s+(?:find|locate|answer|determine|verify|confirm|retrieve|provide)\b/i,
  /\b(?:unable|not able) to\s+(?:find|locate|answer|determine|provide|retrieve)\b/i,
  /\bno (?:relevant |matching |specific |official |public )?(?:information|data|documentation) (?:is |was )?(?:available|found|provided)\b/i,
  /\bnot enough information\b/i,
  /\binsufficient (?:information|context|details?)\b/i,
  /\bi'?m not sure\b/i,
  /\b(?:cannot|can'?t|unable to) be (?:determined|answered|confirmed) (?:from|by|using) the (?:available )?documentation\b/i,
  /\boutside (?:of )?(?:the|my) (?:knowledge|scope|documentation)\b/i,
  /\b(?:please|could you) (?:clarify|rephrase|specify)\b/i,
];

/**
 * "The documentation does not cover this" statements.
 *
 * Verified live on 2026-10-16: asked for a PROS market price, the service replied
 * "The Pharos developer documentation does not contain cryptocurrency price data, …" and cited
 * no docs.pharos.xyz page — only binance.com. For a *documentation search* tool that is a
 * no-answer, so a gap statement is treated as one **only when the service also returned no
 * docs.pharos.xyz reference**. A rich answer that mentions a documentation gap *and* cites the
 * pages it is summarising stays an answer (this is what the faucet question does).
 */
const DOCUMENTATION_GAP_PATTERNS = [
  /\b(?:the |available |pharos |official )?(?:developer )?(?:documentation|docs) (?:does not|doesn'?t|do not|don'?t) (?:contain|provide|include|cover|address|mention|describe|publish|list|specify|state)\b/i,
  /\bnot (?:documented|covered|mentioned|described|available|published|listed) in the (?:available |pharos |official )?(?:developer )?(?:documentation|docs)\b/i,
  /\bthe (?:available |pharos |official )?(?:developer )?(?:documentation|docs) (?:has|have) no (?:information|details?|data|guidance) (?:about|on|for|regarding)\b/i,
  /\bthe (?:available |pharos |official )?documentation is silent (?:about|on|regarding)\b/i,
];

/**
 * @param {{
 *   text: string,
 *   errors?: { code: string, message: string }[],
 *   finished?: boolean,
 *   timedOut?: boolean,
 *   interrupted?: boolean,
 * }} reply
 * @param {{ requireSources?: boolean }} [options]
 * @returns {{
 *   status: "ok" | "no-answer" | "error",
 *   reason: string | null,
 *   message: string | null,
 *   hint: string | null,
 *   answer: string,
 *   sources: import("./sources.mjs").SourceRef[],
 *   pharosSources: import("./sources.mjs").SourceRef[],
 *   externalSources: import("./sources.mjs").SourceRef[],
 *   warnings: string[],
 * }}
 */
export function assessAnswer(reply, options = {}) {
  const answer = typeof reply?.text === "string" ? reply.text.trim() : "";
  const errors = Array.isArray(reply?.errors) ? reply.errors : [];
  const { sources, pharosDocs, external } = extractSources(answer);
  // Normalise typographic punctuation so the insufficient-answer probes work on prose that
  // uses curly apostrophes/quotes (the live service emits both).
  const probe = answer.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');

  /** @type {string[]} */
  const warnings = [];
  if (reply?.timedOut && answer) warnings.push(PARTIAL_ANSWER_NOTE);
  else if (reply?.interrupted && answer) warnings.push(INTERRUPTED_STREAM_NOTE);

  /** @type {ReturnType<typeof assessAnswer>} */
  const base = {
    status: "ok",
    reason: null,
    message: null,
    hint: null,
    answer,
    sources,
    pharosSources: pharosDocs,
    externalSources: external,
    warnings,
  };

  // 1. A stream error frame means the interaction itself failed, whatever text arrived first.
  if (errors.length > 0) {
    return {
      ...base,
      status: "error",
      reason: "stream-error",
      message: `the documentation service reported an error: ${errors
        .map((e) => `${e.code || "ERROR"}${e.message ? ` (${e.message})` : ""}`)
        .join("; ")}`,
      hint: "Retry in a moment; if it persists the documentation service may be degraded.",
    };
  }

  // 2. Empty text. A deadline or a cut-off stream is an operational failure, not a "no answer".
  if (!answer) {
    if (reply?.timedOut) {
      return {
        ...base,
        status: "error",
        reason: "timeout-no-content",
        message: "the documentation service did not start answering before the stream deadline",
        hint: "Retry, or raise the deadline with --timeout <seconds> / PHAROS_STREAM_TIMEOUT_MS.",
      };
    }
    if (reply?.interrupted) {
      return {
        ...base,
        status: "error",
        reason: "interrupted-stream-no-content",
        message: "the response stream ended before any answer arrived",
        hint: "Retry; if it persists the documentation service may be degraded.",
      };
    }
    return {
      ...base,
      status: "no-answer",
      reason: "empty-response",
      message: NO_ANSWER_MESSAGE,
    };
  }

  const insufficient = INSUFFICIENT_PATTERNS.find((re) => re.test(probe));
  if (insufficient) {
    return {
      ...base,
      status: "no-answer",
      reason: `insufficient-answer (${insufficient.source})`,
      message: NO_ANSWER_MESSAGE,
    };
  }

  // The service said the documentation does not cover the question, and it cited no Pharos
  // documentation page either. There is no documented answer to report, only the gap itself
  // (which stays visible through --json/--debug).
  const gap = DOCUMENTATION_GAP_PATTERNS.find((re) => re.test(probe));
  if (gap && pharosDocs.length === 0) {
    return {
      ...base,
      status: "no-answer",
      reason: "documentation-does-not-cover",
      message: NO_ANSWER_MESSAGE,
    };
  }

  if (options.requireSources && sources.length === 0) {
    return {
      ...base,
      status: "no-answer",
      reason: "no-sources (--require-sources)",
      message: NO_ANSWER_MESSAGE,
    };
  }

  if (sources.length === 0) warnings.push(NO_SOURCE_NOTE);
  return base;
}
