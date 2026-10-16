import test from "node:test";
import assert from "node:assert/strict";
import { redactDeep, redactHeaders, redactJson, redactText } from "../src/redact.mjs";
import { FAKE_JWT, FAKE_SESSION_ID, FIXTURES_DIR, fixtureJson } from "./helpers/mock.mjs";

const PRIVATE_KEY = `0x${"ab".repeat(32)}`;

test("JWTs, UUIDs, bearer headers and hex key material are redacted", () => {
  const out = redactText(`token=${FAKE_JWT} session=${FAKE_SESSION_ID} auth="Bearer ${FAKE_JWT}" key=${PRIVATE_KEY}`);
  assert.ok(!out.includes(FAKE_JWT));
  assert.ok(!out.includes(FAKE_SESSION_ID));
  assert.ok(!out.includes(PRIVATE_KEY));
  assert.match(out, /<redacted-jwt>/);
  assert.match(out, /<redacted-id>/);
  assert.match(out, /<redacted-hex>/);
});

test("UUID redaction can be disabled when ids must stay readable", () => {
  const out = redactText(`session ${FAKE_SESSION_ID}`, { uuids: false });
  assert.equal(out, `session ${FAKE_SESSION_ID}`);
});

test("nested structures redact credential-named keys wholesale", () => {
  const redacted = redactDeep({
    accessToken: FAKE_JWT,
    nested: { authorization: "Bearer abcdefghijklmnop", list: [FAKE_JWT, { privateKey: PRIVATE_KEY, keep: "ok" }] },
    note: `uses ${FAKE_SESSION_ID}`,
  });
  assert.equal(redacted.accessToken, "<redacted>");
  assert.equal(redacted.nested.authorization, "<redacted>");
  assert.equal(redacted.nested.list[1].privateKey, "<redacted>");
  assert.equal(redacted.nested.list[1].keep, "ok");
  assert.ok(!JSON.stringify(redacted).includes(FAKE_SESSION_ID));
});

test("header redaction keeps debugging value without leaking the bearer token", () => {
  const out = redactHeaders({ Authorization: `Bearer ${FAKE_JWT}`, Accept: "text/event-stream" });
  assert.equal(out.Authorization, "Bearer <redacted>");
  assert.equal(out.Accept, "text/event-stream");
});

test("the fabricated session fixture is fully redacted by redactJson", () => {
  const json = redactJson(fixtureJson("session.json"));
  assert.ok(!json.includes(FAKE_JWT));
  assert.match(json, /<redacted>/);
});

test("raw SSE frames with an embedded token are safe to print", () => {
  const frame = `data:{"choices":[{"delta":{"content":"here is the token ${FAKE_JWT}"}}]}`;
  const out = redactText(frame);
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature"));
});

test("every fixture the suite depends on is present and tracked", async () => {
  // Regression guard: a bare `session.json` line in .gitignore once excluded
  // test/fixtures/session.json, which only showed up when cloning the repository.
  const { readdir } = await import("node:fs/promises");
  const present = await readdir(FIXTURES_DIR);
  for (const name of [
    "agents.json",
    "bootstrap.json",
    "chat-answer.sse",
    "chat-error.sse",
    "chat-interrupted.sse",
    "chat-vague.sse",
    "conversations.json",
    "session.json",
  ]) {
    assert.ok(present.includes(name), `missing fixture file: test/fixtures/${name}`);
  }
});
