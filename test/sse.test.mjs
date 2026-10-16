import test from "node:test";
import assert from "node:assert/strict";
import { collectReply, createSseDecoder, normalizePayload } from "../src/sse.mjs";

test("decodes an event that is split across chunk boundaries", () => {
  const decoder = createSseDecoder();
  const events = [
    ...decoder.push('data:{"choices":[{"delta":{"cont'),
    ...decoder.push('ent":"Hel"}}]}\n'),
    ...decoder.push('data:{"choices":[{"delta":{"content":"lo"}}]}\n'),
  ];
  assert.deepEqual(events, [
    { type: "content", delta: "Hel" },
    { type: "content", delta: "lo" },
  ]);
  assert.equal(collectReply(events).text, "Hello");
});

test("handles CRLF, comment/heartbeat lines, blank lines and non-data fields", () => {
  const decoder = createSseDecoder();
  const chunk =
    ": keep-alive\r\n" +
    "\r\n" +
    "event: message\r\n" +
    'id: 42\r\n' +
    'data:{"choices":[{"delta":{"content":"ok"}}]}\r\n' +
    "data:[DONE]\r\n";
  const events = decoder.push(chunk);
  assert.deepEqual(events, [
    { type: "content", delta: "ok" },
    { type: "done" },
  ]);
  assert.equal(decoder.stats.comments, 1);
  assert.equal(decoder.stats.malformedFrames, 0);
});

test("malformed JSON frames are skipped and counted, never thrown", () => {
  const decoder = createSseDecoder();
  const events = [
    ...decoder.push("data:{not json at all\n"),
    ...decoder.push("data:{\"choices\":[{\"delta\":{\"content\":\"survives\"}}]}\n"),
    ...decoder.push("data:[DONE]\n"),
  ];
  assert.deepEqual(events, [
    { type: "content", delta: "survives" },
    { type: "done" },
  ]);
  assert.equal(decoder.stats.malformedFrames, 1);
  assert.equal(collectReply(events).finished, true);
});

test("flush() decodes a final line that has no trailing newline", () => {
  const decoder = createSseDecoder();
  assert.deepEqual(decoder.push('data:{"choices":[{"delta":{"content":"tail"}}]}'), []);
  assert.deepEqual(decoder.flush(), [{ type: "content", delta: "tail" }]);
});

test("an interrupted stream simply ends without a done frame", () => {
  const decoder = createSseDecoder();
  const events = [...decoder.push('data:{"choices":[{"delta":{"content":"partial"}}]}\n'), ...decoder.flush()];
  const reply = collectReply(events);
  assert.equal(reply.text, "partial");
  assert.equal(reply.finished, false);
});

test("normalizePayload maps reasoning, finish_reason, cards and error frames", () => {
  assert.deepEqual(normalizePayload({ choices: [{ delta: { reasoning_content: "why" } }] }), [
    { type: "reasoning", delta: "why" },
  ]);
  assert.deepEqual(normalizePayload({ choices: [{ delta: {}, finish_reason: "stop" }] }), [
    { type: "finish", reason: "stop" },
  ]);
  assert.deepEqual(normalizePayload({ card: [{ type: "doc", url: "https://docs.example.invalid" }] }), [
    { type: "card", card: { type: "doc", url: "https://docs.example.invalid" } },
  ]);
  assert.deepEqual(normalizePayload({ error: { code: "X", message: "boom" } }), [
    { type: "error", code: "X", message: "boom" },
  ]);
  assert.deepEqual(normalizePayload(null), []);
  assert.deepEqual(normalizePayload("a string"), []);
});

test("collectReply separates content, reasoning, cards and errors", () => {
  const reply = collectReply([
    { type: "reasoning", delta: "r1" },
    { type: "reasoning", delta: "r2" },
    { type: "content", delta: "c1" },
    { type: "card", card: { type: "a" } },
    { type: "error", code: "E", message: "m" },
  ]);
  assert.equal(reply.reasoning, "r1r2");
  assert.equal(reply.text, "c1");
  assert.deepEqual(reply.cards, [{ type: "a" }]);
  assert.deepEqual(reply.errors, [{ code: "E", message: "m" }]);
  assert.equal(reply.finished, false);
});
