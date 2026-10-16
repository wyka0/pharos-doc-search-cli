/**
 * Redaction helpers.
 *
 * Nothing the CLI prints in `--debug` mode may contain a live credential. The Pharos
 * Agent Center issues short-lived bearer JWTs and session/request UUIDs; local login
 * state also holds a throwaway EOA private key. All of these are redacted before they
 * can reach stdout, stderr or a written artifact.
 *
 * Adapted for this project from the Task 3 reference implementation
 * (`pharos-docs-mcp-onboarding/src/redact.mjs`) and extended with bearer headers and
 * hex key material.
 */

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** 32-byte hex: private keys and tx hashes alike. Over-redacting here is intentional. */
const HEX32_RE = /\b0x[0-9a-f]{64}\b/gi;
const SENSITIVE_KEY_RE = /^(access_?token|authorization|refresh_?token|token|private_?key|signature|secret|api_?key)$/i;

/**
 * @param {string} input
 * @param {{ uuids?: boolean }} [opts] `uuids: false` keeps session/request ids readable.
 * @returns {string}
 */
export function redactText(input, opts = {}) {
  let out = String(input).replace(BEARER_RE, "Bearer <redacted>").replace(JWT_RE, "<redacted-jwt>");
  out = out.replace(HEX32_RE, "<redacted-hex>");
  if (opts.uuids !== false) out = out.replace(UUID_RE, "<redacted-id>");
  return out;
}

/**
 * Recursively redact a value. Object keys that name credentials are replaced wholesale.
 * @template T
 * @param {T} value
 * @param {{ uuids?: boolean }} [opts]
 * @returns {T}
 */
export function redactDeep(value, opts = {}) {
  if (typeof value === "string") return /** @type {T} */ (redactText(value, opts));
  if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => redactDeep(v, opts)));
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "<redacted>" : redactDeep(v, opts);
    }
    return /** @type {T} */ (out);
  }
  return value;
}

/**
 * Redact a header record, keeping non-secret headers visible for debugging.
 * @param {Record<string, unknown>} headers
 */
export function redactHeaders(headers) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = /^authorization$/i.test(k) ? "Bearer <redacted>" : redactDeep(v);
  }
  return out;
}

/** Redact a JSON-serialisable value and return a pretty string. */
export function redactJson(value) {
  return JSON.stringify(redactDeep(value), null, 2);
}
