/**
 * Client for the Pharos "Developer Docs MCP" agent (`agentType: PHAROS_DOCS`) hosted at
 * ai.pharos.xyz.
 *
 * Only the two verified endpoints are used — nothing is guessed:
 *
 *   1. Anonymous guest bootstrap (and the wallet sign-in legs used by `--login`)
 *      POST https://flow.anvita.xyz/api/v1/widget/bootstrap
 *      -> { data: { accessToken, tokenType, expiresAt, session: { id, remainingQuota } } }
 *
 *   2. Chat completion over Server-Sent Events — this is the actual "Docs MCP" query path
 *      POST https://flow.anvita.xyz/api/v1/pharos/chat/completions
 *      headers: Accept: text/event-stream, Authorization: Bearer <token>
 *      body:   { spaceType: "pharos", operationType: "chat", agentType, sessionId,
 *                message, requestId, stream: true }
 *
 * Notes that were established by experiment in the Task 3 reference project and hold here:
 *   - the API requires the browser `Origin`/`Referer` headers (403 otherwise)
 *   - the *widget* session id from `/widget/bootstrap` is rejected by the chat endpoint;
 *     the `chatSessionId` exposed by `/conversations/session/{id}/agents` must be used
 *   - an anonymous GUEST token is rejected by the chat endpoint with
 *     HTTP 401 `{"code":"401","message":"Unauthorized, please login first"}`
 *   - this is the Docs MCP (a documentation assistant), NOT the Pharos Chain MCP
 *     (`https://mcp.pharos.xyz/mcp`, on-chain data). This client never calls the Chain MCP.
 *
 * The implementation is dependency-free and takes `fetch` by injection so the whole client
 * can be unit tested offline.
 */

import { randomUUID } from "node:crypto";
import { PharosError, toPharosError } from "./errors.mjs";
import { collectReply, createSseDecoder } from "./sse.mjs";

/** Both the widget API and the chat API are served from this host (verified live). */
export const API_BASE = "https://flow.anvita.xyz";
export const BOOTSTRAP_URL = `${API_BASE}/api/v1/widget/bootstrap`;
export const CHAT_URL = `${API_BASE}/api/v1/pharos/chat/completions`;
export const APP_KEY = "agent_center";
export const SITE_ORIGIN = "https://ai.pharos.xyz";
export const SITE_REFERER = "https://ai.pharos.xyz/";

/** Agent ids exposed on the ai.pharos.xyz surface. Only DOCS is used by default. */
export const AGENT_TYPES = Object.freeze({
  GENERAL: "PHAROS_PERSONAL_AGENT",
  DOCS: "PHAROS_DOCS",
  SKILL_ENGINE: "PHAROS_SKILL_ENGINE",
  CHAIN_MCP: "PHAROS_MCP",
});

/**
 * Default deadline for one answer. Answers observed on the live service took 27-147s;
 * the reference client used 600s. 300s keeps a stalled stream from hanging a script while
 * still leaving headroom for multi-page lookups.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

/** Cap the raw frames retained for `--debug` so a huge answer cannot exhaust memory. */
const MAX_RETAINED_FRAMES = 400;

export class PharosDocsClient {
  /**
   * @param {{
   *   fetch?: typeof fetch,
   *   streamTimeoutMs?: number,
   *   onTrace?: (entry: { kind: string, at: string, detail: Record<string, unknown> }) => void,
   * }} [options]
   */
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw new PharosError("a fetch implementation is required (Node >= 20)", {
        kind: "usage",
        hint: "Run the CLI with Node 20 or newer.",
      });
    }
    this.streamTimeoutMs = options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    this.onTrace = options.onTrace ?? null;
    /** @type {{ accessToken: string, tokenType: string, expiresAt: string, sessionId: string, remainingQuota: number|null } | null} */
    this.auth = null;
    /** @type {Map<string, string>} */
    this.#chatSessions = new Map();
  }

  /** @type {Map<string, string>} */
  #chatSessions;

  /**
   * Attach a bearer token obtained outside the client (cached session / env var).
   * @param {{ accessToken: string, tokenType?: string, expiresAt?: string, sessionId?: string }} auth
   */
  setAuth(auth) {
    this.auth = {
      accessToken: auth.accessToken,
      tokenType: auth.tokenType ?? "AUTHENTICATED",
      expiresAt: auth.expiresAt ?? "",
      sessionId: auth.sessionId ?? "",
      remainingQuota: null,
    };
    return this;
  }

  /**
   * Anonymous guest session (what the public web page does on first load).
   * Not sufficient to ask the Docs MCP a question — see `setAuth` / `--login`.
   * @returns {Promise<{ tokenType: string, expiresAt: string, sessionId: string, remainingQuota: number|null, supportedChains: string[] }>}
   */
  async bootstrap() {
    const body = { appKey: APP_KEY, clientNonce: `bootstrap-${randomUUID()}` };
    const json = await this.#postJson(BOOTSTRAP_URL, body, {
      Authorization: "",
      Origin: SITE_ORIGIN,
      Referer: SITE_REFERER,
    });
    const data = json?.data ?? {};
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!accessToken) {
      throw new PharosError("the guest bootstrap response contained no access token", {
        kind: "mcp",
        url: BOOTSTRAP_URL,
        hint: "The Pharos Agent Center API may have changed; re-run with --debug for details.",
      });
    }
    this.auth = {
      accessToken,
      tokenType: data.tokenType ?? "GUEST",
      expiresAt: data.expiresAt ?? "",
      sessionId: data?.session?.id ?? "",
      remainingQuota: typeof data?.session?.remainingQuota === "number" ? data.session.remainingQuota : null,
    };
    this.#trace("bootstrap", {
      url: BOOTSTRAP_URL,
      tokenType: this.auth.tokenType,
      expiresAt: this.auth.expiresAt,
      remainingQuota: this.auth.remainingQuota,
      supportedChains: data?.config?.supportedChains ?? null,
    });
    return {
      tokenType: this.auth.tokenType,
      expiresAt: this.auth.expiresAt,
      sessionId: this.auth.sessionId,
      remainingQuota: this.auth.remainingQuota,
      supportedChains: Array.isArray(data?.config?.supportedChains) ? data.config.supportedChains : [],
    };
  }

  /** Wallet sign-in step 1: request the SIWE-style message to sign. */
  async requestWalletChallenge({ address, chainId }) {
    const url = `${API_BASE}/api/v1/widget/wallet/challenge`;
    const json = await this.#postJson(url, { address, chainId, appKey: APP_KEY }, this.#siteHeaders());
    const data = json?.data ?? {};
    if (!data.challengeId || !data.message) {
      throw new PharosError("the wallet challenge response did not contain a message to sign", {
        kind: "mcp",
        url,
        hint: "The Pharos Agent Center sign-in API may have changed.",
      });
    }
    return { challengeId: data.challengeId, message: data.message, expiresAt: data.expiresAt };
  }

  /** Wallet sign-in step 2: submit the EIP-191 signature over the challenge message. */
  async verifyWallet({ challengeId, address, signature, terminalSource = "UNKNOWN_WALLET" }) {
    const url = `${API_BASE}/api/v1/widget/agentcenter/wallet/verify`;
    const json = await this.#postJson(
      url,
      { challengeId, address, signature, appKey: "pharos", terminalSource },
      this.#siteHeaders(),
    );
    const data = json?.data ?? {};
    if (!data.accessToken) {
      throw new PharosError("wallet verification did not return a session token", {
        kind: "auth",
        url,
        hint: "Re-run `pharos-docs --login`; if it persists the sign-in API may have changed.",
      });
    }
    this.setAuth({
      accessToken: data.accessToken,
      tokenType: data.tokenType ?? "AUTHENTICATED",
      expiresAt: data.expiresAt ?? "",
      sessionId: data?.session?.id ?? this.auth?.sessionId ?? "",
    });
    /** @type {{ tokenType: string, expiresAt: string, sessionId: string }} */
    const out = {
      tokenType: this.auth.tokenType,
      expiresAt: this.auth.expiresAt,
      sessionId: this.auth.sessionId,
    };
    return out;
  }

  /** `POST /api/v1/widget/onboarding/guardian-claims/prepare` (first-time accounts only). */
  async prepareGuardianClaim() {
    const url = `${API_BASE}/api/v1/widget/onboarding/guardian-claims/prepare`;
    const json = await this.#postJson(url, { clientRequestId: randomUUID() }, this.#siteHeaders());
    const data = json?.data ?? {};
    if (!data.operationId || !data.typedData) {
      throw new PharosError("the guardian-claim preparation step returned no operation", {
        kind: "mcp",
        url,
      });
    }
    return { operationId: data.operationId, typedData: data.typedData, deadline: data.deadline };
  }

  /** `POST /api/v1/widget/onboarding/guardian-claims/{operationId}/submit` */
  async submitGuardianClaim({ operationId, signature }) {
    const url = `${API_BASE}/api/v1/widget/onboarding/guardian-claims/${encodeURIComponent(operationId)}/submit`;
    const json = await this.#postJson(url, { signature, clientRequestId: randomUUID() }, this.#siteHeaders());
    return { ok: json?.code === "000000", code: json?.code ?? null, message: json?.message ?? null, data: json?.data ?? null };
  }

  /** `GET /api/v1/widget/onboarding/guardian-claims/{operationId}` */
  async guardianClaimStatus({ operationId }) {
    const url = `${API_BASE}/api/v1/widget/onboarding/guardian-claims/${encodeURIComponent(operationId)}`;
    const json = await this.#getJson(url);
    return { code: json?.code ?? null, data: json?.data ?? null };
  }

  /** `GET /api/v1/widget/onboarding/status` */
  async onboardingStatus() {
    const url = `${API_BASE}/api/v1/widget/onboarding/status`;
    const json = await this.#getJson(url);
    return { code: json?.code ?? null, data: json?.data ?? null };
  }

  /**
   * Poll the onboarding state machine until the hosted agent stops reporting `POLL`.
   * @param {{ maxPolls?: number, sleep?: (ms: number) => Promise<void> }} [options]
   */
  async waitForOnboarding(options = {}) {
    const maxPolls = options.maxPolls ?? 20;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last = null;
    for (let i = 0; i < maxPolls; i += 1) {
      const { data } = await this.onboardingStatus();
      last = data ?? {};
      if (last.nextAction !== "POLL") return last;
      await sleep(typeof last.retryAfterMs === "number" ? last.retryAfterMs : 3000);
    }
    return last ?? {};
  }

  /** `POST /api/v1/widget/agentcenter/onboarding/complete` */
  async completeOnboarding() {
    const url = `${API_BASE}/api/v1/widget/agentcenter/onboarding/complete`;
    const json = await this.#postJson(url, { clientRequestId: randomUUID() }, this.#siteHeaders());
    const data = json?.data ?? {};
    if (data.accessToken) {
      this.setAuth({
        accessToken: data.accessToken,
        tokenType: data.tokenType ?? this.auth?.tokenType ?? "ONBOARDING",
        expiresAt: data.expiresAt ?? this.auth?.expiresAt ?? "",
        sessionId: this.auth?.sessionId ?? "",
      });
    }
    return {
      ok: json?.code === "000000",
      code: json?.code ?? null,
      message: json?.message ?? null,
      state: data.state ?? null,
      tokenType: this.auth?.tokenType ?? null,
    };
  }

  /**
   * Resolve the `chatSessionId` the chat endpoint expects for an agent type.
   * The widget session id is NOT accepted by the chat endpoint (observed HTTP 500/401).
   */
  async resolveChatSession(agentType = AGENT_TYPES.DOCS) {
    const cached = this.#chatSessions.get(agentType);
    if (cached) return cached;

    const listUrl = `${API_BASE}/api/v1/pharos/conversations/session`;
    const list = await this.#getJson(listUrl);
    const parent = Array.isArray(list?.data) ? list.data[0] : null;
    if (!parent?.sessionId) {
      throw new PharosError("this account exposes no conversation session for the Docs MCP", {
        kind: "auth",
        url: listUrl,
        hint: "The cached login is incomplete or expired. Re-run `pharos-docs --login`.",
      });
    }

    const agentsUrl = `${API_BASE}/api/v1/pharos/conversations/session/${encodeURIComponent(parent.sessionId)}/agents`;
    const agents = await this.#getJson(agentsUrl);
    const available = Array.isArray(agents?.data?.agents) ? agents.data.agents : [];
    const match = available.find((a) => a?.agentType === agentType);
    if (!match?.chatSessionId) {
      throw new PharosError(
        `the Docs MCP agent (${agentType}) is not attached to this account's session`,
        {
          kind: "mcp",
          url: agentsUrl,
          hint: `Available agents: ${available.map((a) => a?.agentType).filter(Boolean).join(", ") || "none"}.`,
        },
      );
    }
    this.#chatSessions.set(agentType, match.chatSessionId);
    return match.chatSessionId;
  }

  /**
   * Ask the Docs MCP a question and accumulate the streamed answer.
   *
   * @param {string} message
   * @param {{ agentType?: string, sessionId?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<{
   *   text: string, reasoning: string, cards: unknown[], errors: {code: string, message: string}[],
   *   finished: boolean, timedOut: boolean, interrupted: boolean,
   *   requestId: string, sessionId: string, agentType: string,
   *   frames: string[], stats: { malformedFrames: number, dataFrames: number, comments: number },
   * }>}
   */
  async ask(message, options = {}) {
    const agentType = options.agentType ?? AGENT_TYPES.DOCS;
    if (!this.auth?.accessToken) {
      throw new PharosError("no authenticated session is available for the Docs MCP", {
        kind: "auth",
        hint: "Run `pharos-docs --login` to sign in, or set PHAROS_ACCESS_TOKEN.",
      });
    }
    const sessionId = options.sessionId ?? (await this.resolveChatSession(agentType));
    const timeoutMs = options.timeoutMs ?? this.streamTimeoutMs;
    const requestId = randomUUID();
    const body = {
      spaceType: "pharos",
      operationType: "chat",
      agentType,
      sessionId,
      message,
      requestId,
      stream: true,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", externalAbort, { once: true });

    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: SITE_ORIGIN,
      Referer: SITE_REFERER,
      Authorization: `Bearer ${this.auth.accessToken}`,
    };

    this.#trace("chat.request", {
      url: CHAT_URL,
      agentType,
      messageChars: message.length,
      stream: true,
      authorization: "Bearer <redacted>",
    });

    /** @type {import("./sse.mjs").StreamEvent[]} */
    const events = [];
    /** @type {string[]} */
    const frames = [];
    let timedOut = false;
    let interrupted = false;
    let reader;

    try {
      /** @type {Response} */
      let res;
      try {
        res = await this.fetch(CHAT_URL, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      } catch (err) {
        throw toPharosError(err, { url: CHAT_URL });
      }
      this.#trace("chat.response", { status: res.status, contentType: res.headers?.get?.("content-type") ?? null });

      if (!res.ok) {
        throw await httpError(res, CHAT_URL);
      }
      if (!res.body) {
        throw new PharosError("the Docs MCP returned an empty response body", {
          kind: "stream",
          url: CHAT_URL,
          hint: "Retry; if it persists the service may be degraded.",
        });
      }

      const decoder = createSseDecoder();
      reader = res.body.getReader();
      const textDecoder = new TextDecoder();
      // fetch()'s AbortSignal does not reliably unblock a stalled body read, so race every
      // read against the same deadline. This is what keeps a partial answer instead of
      // hanging the CLI forever.
      const deadline = new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("stream deadline reached"), { name: "AbortError" })),
          { once: true },
        );
      });

      for (;;) {
        let chunk;
        try {
          chunk = await Promise.race([reader.read(), deadline]);
        } catch (err) {
          if (err?.name === "AbortError") {
            timedOut = true;
            break;
          }
          throw err;
        }
        if (chunk.done) break;
        const text = textDecoder.decode(chunk.value, { stream: true });
        for (const line of text.split("\n")) {
          if (line.trim() && frames.length < MAX_RETAINED_FRAMES) frames.push(line);
        }
        events.push(...decoder.push(text));
      }
      events.push(...decoder.flush());
      if (!timedOut) {
        // A stream that ends without `data: [DONE]` was cut short (proxy, server restart).
        interrupted = !events.some((e) => e.type === "done");
      }
      return this.#finish(events, decoder.stats, { frames, requestId, sessionId, agentType, timedOut, interrupted });
    } catch (err) {
      if (timedOut || (events.length > 0 && err?.name === "AbortError")) {
        // Keep whatever legitimately streamed in before the deadline.
        const decoder = createSseDecoder();
        return this.#finish(events, decoder.stats, { frames, requestId, sessionId, agentType, timedOut: true, interrupted: false });
      }
      throw err instanceof PharosError ? err : toPharosError(err, { url: CHAT_URL });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", externalAbort);
      if (timedOut) await reader?.cancel?.().catch(() => {});
    }
  }

  /**
   * @param {import("./sse.mjs").StreamEvent[]} events
   * @param {{ malformedFrames: number, dataFrames: number, comments: number }} stats
   */
  #finish(events, stats, meta) {
    const reply = collectReply(events);
    const result = {
      ...reply,
      timedOut: meta.timedOut,
      interrupted: meta.interrupted,
      requestId: meta.requestId,
      sessionId: meta.sessionId,
      agentType: meta.agentType,
      frames: meta.frames,
      stats,
    };
    this.#trace("chat.result", {
      finished: result.finished,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      contentChars: result.text.length,
      cardCount: result.cards.length,
      errors: result.errors,
      malformedFrames: stats.malformedFrames,
    });
    return result;
  }

  /** Headers the ai.pharos.xyz web app sends implicitly via the browser. */
  #siteHeaders({ withAuth = true } = {}) {
    return {
      Origin: SITE_ORIGIN,
      Referer: SITE_REFERER,
      ...(withAuth && this.auth?.accessToken ? { Authorization: `Bearer ${this.auth.accessToken}` } : {}),
    };
  }

  /**
   * @param {string} url
   * @param {any} body
   * @param {Record<string, string>} headers
   */
  async #postJson(url, body, headers) {
    /** @type {Response} */
    let res;
    try {
      res = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw toPharosError(err, { url });
    }
    if (!res.ok) throw await httpError(res, url);
    return parseJsonBody(await res.text());
  }

  /** @param {string} url */
  async #getJson(url) {
    /** @type {Response} */
    let res;
    try {
      res = await this.fetch(url, { headers: this.#siteHeaders() });
    } catch (err) {
      throw toPharosError(err, { url });
    }
    if (!res.ok) throw await httpError(res, url);
    return parseJsonBody(await res.text());
  }

  /** @param {string} kind @param {Record<string, unknown>} detail */
  #trace(kind, detail) {
    this.onTrace?.({ kind, at: new Date().toISOString(), detail });
  }
}

/**
 * Convert a non-OK HTTP response into an actionable `PharosError`.
 * @param {Response} res
 * @param {string} url
 */
export async function httpError(res, url) {
  const text = await res.text().catch(() => "");
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text ? { raw: text.slice(0, 300) } : null;
  }
  const apiCode = body?.code != null ? String(body.code) : null;
  const apiMessage = body?.message ?? body?.msg ?? null;

  if (res.status === 401 || res.status === 403) {
    return new PharosError(
      `the Pharos Docs MCP rejected the request (HTTP ${res.status}${apiMessage ? `: ${apiMessage}` : ""})`,
      {
        kind: "auth",
        status: res.status,
        url,
        code: apiCode,
        hint: "The Docs MCP requires a wallet-authenticated session; anonymous guest sessions are refused. Run `pharos-docs --login` (or refresh PHAROS_ACCESS_TOKEN).",
        details: body,
      },
    );
  }
  if (res.status === 429) {
    return new PharosError("the Pharos Docs MCP rate-limited this account (HTTP 429)", {
      kind: "http",
      status: 429,
      url,
      code: apiCode,
      hint: "Wait and retry, or sign in with a different wallet to get a fresh quota.",
      details: body,
    });
  }
  return new PharosError(
    `the Pharos Docs MCP request failed (HTTP ${res.status}${apiMessage ? `: ${apiMessage}` : ""})`,
    {
      kind: "http",
      status: res.status,
      url,
      code: apiCode,
      hint: "Retry in a moment; if it persists the service may be degraded.",
      details: body,
    },
  );
}

/**
 * Parse a JSON body defensively — a malformed body must not crash the CLI with a stack trace.
 * @param {string} text
 */
function parseJsonBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new PharosError("the Pharos Agent Center returned a malformed JSON response", {
      kind: "mcp",
      hint: "Retry; the service may have returned an HTML error page.",
    });
  }
}

export default PharosDocsClient;
