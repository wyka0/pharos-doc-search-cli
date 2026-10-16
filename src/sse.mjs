/**
 * Server-Sent Events decoder for the Pharos Agent Center chat stream.
 *
 * Observed live wire format for
 * `POST https://flow.anvita.xyz/api/v1/pharos/chat/completions`:
 *
 *   Content-Type: text/event-stream
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   ...
 *   data: [DONE]
 *
 * Robustness rules (each one is covered by a unit test):
 *   - events may be split across chunk boundaries; the trailing partial line is buffered
 *   - CRLF and LF line endings both work
 *   - blank lines and `:` comment/heartbeat lines are ignored
 *   - non-`data:` fields (`event:`, `id:`, `retry:`) are ignored
 *   - malformed JSON in a `data:` frame is skipped and counted, never thrown
 *   - a final line without a trailing newline is still decoded on `flush()`
 *   - an interrupted stream (EOF before `data: [DONE]`) simply stops producing events;
 *     the caller decides what a missing `done` frame means
 */

/** @typedef {{ type: "content", delta: string }
 *  | { type: "reasoning", delta: string }
 *  | { type: "finish", reason: string }
 *  | { type: "card", card: unknown }
 *  | { type: "error", code: string, message: string }
 *  | { type: "done" }} StreamEvent */

/** Deliberately does not export the raw payload: it may embed the prompt/answer only. */
export function normalizePayload(payload) {
  /** @type {StreamEvent[]} */
  const events = [];
  if (!payload || typeof payload !== "object") return events;

  if (payload.error) {
    events.push({
      type: "error",
      code: String(payload.error.code ?? ""),
      message: String(payload.error.message ?? ""),
    });
    return events;
  }

  let sawCard = false;
  for (const card of Array.isArray(payload.card) ? payload.card : []) {
    if (card && typeof card.type === "string") {
      events.push({ type: "card", card });
      sawCard = true;
    }
  }
  if (payload.content_type === "CARD" && !sawCard) {
    const withResult = (Array.isArray(payload.card) ? payload.card : []).find((c) => c && c.result) ?? null;
    events.push({
      type: "card",
      card: { type: payload.card_type ?? payload.type ?? "card", result: withResult?.result ?? null },
    });
  }

  for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      events.push({ type: "content", delta: delta.content });
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      events.push({ type: "reasoning", delta: delta.reasoning_content });
    }
    if (choice?.finish_reason) events.push({ type: "finish", reason: String(choice.finish_reason) });
  }
  return events;
}

/**
 * @param {{ onMalformed?: (line: string) => void }} [options]
 * @returns {{ push(chunk: string): StreamEvent[], flush(): StreamEvent[], stats: { malformedFrames: number, dataFrames: number, comments: number } }}
 */
export function createSseDecoder(options = {}) {
  let buffer = "";
  const stats = { malformedFrames: 0, dataFrames: 0, comments: 0 };

  /** @param {string} text @returns {StreamEvent[]} */
  function consume(text) {
    /** @type {StreamEvent[]} */
    const events = [];
    const lines = text.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      if (line.startsWith(":")) {
        stats.comments += 1;
        continue;
      }
      if (!line.startsWith("data:")) continue; // event:/id:/retry: are not used by this API
      stats.dataFrames += 1;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        events.push({ type: "done" });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        stats.malformedFrames += 1;
        options.onMalformed?.(data);
        continue;
      }
      events.push(...normalizePayload(parsed));
    }
    return events;
  }

  return {
    push(chunk) {
      buffer += chunk;
      return consume(buffer);
    },
    flush() {
      const remaining = buffer.endsWith("\n") ? buffer : `${buffer}\n`;
      buffer = "";
      return consume(remaining);
    },
    stats,
  };
}

/**
 * Reduce stream events into the assistant reply.
 * @param {StreamEvent[]} events
 */
export function collectReply(events) {
  let text = "";
  let reasoning = "";
  /** @type {unknown[]} */
  const cards = [];
  /** @type {{ code: string, message: string }[]} */
  const errors = [];
  let finished = false;
  for (const ev of events) {
    if (ev.type === "content") text += ev.delta;
    else if (ev.type === "reasoning") reasoning += ev.delta;
    else if (ev.type === "card") cards.push(ev.card);
    else if (ev.type === "error") errors.push({ code: ev.code, message: ev.message });
    else if (ev.type === "done") finished = true;
  }
  return { text, reasoning, cards, errors, finished };
}
