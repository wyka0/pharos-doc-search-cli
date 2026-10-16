import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_TYPES, PharosDocsClient } from "../src/mcp.mjs";
import { PharosError } from "../src/errors.mjs";
import {
  FAKE_JWT,
  answerFrames,
  errorFrames,
  fakeFetch,
  interruptedFrames,
  jsonResponse,
  sseResponse,
  stalledSseResponse,
} from "./helpers/mock.mjs";
import { docsRoutes } from "./helpers/mock.mjs";

/** A client with a fabricated cached token attached. */
function authedClient(fetchImpl, options = {}) {
  return new PharosDocsClient({ fetch: fetchImpl, ...options }).setAuth({
    accessToken: FAKE_JWT,
    tokenType: "AUTHENTICATED",
    expiresAt: "2099-01-01T00:00:00Z",
  });
}

test("bootstrap sends the browser Origin/Referer the API requires and never logs the token", async () => {
  const fetchImpl = fakeFetch(docsRoutes());
  /** @type {any[]} */
  const trace = [];
  const client = new PharosDocsClient({ fetch: fetchImpl, onTrace: (e) => trace.push(e) });
  const session = await client.bootstrap();

  assert.equal(session.tokenType, "GUEST");
  assert.equal(session.remainingQuota, 10);
  assert.deepEqual(session.supportedChains, ["5734951"]);

  const call = fetchImpl.call("/api/v1/widget/bootstrap");
  assert.equal(call.headers.Origin, "https://ai.pharos.xyz");
  assert.equal(call.headers.Referer, "https://ai.pharos.xyz/");
  assert.equal(call.headers.Authorization, "");
  assert.equal(call.body.appKey, "agent_center");
  assert.match(call.body.clientNonce, /^bootstrap-/);

  assert.ok(!JSON.stringify(trace).includes(FAKE_JWT), "the guest token must never reach the trace");
});

test("bootstrap surfaces a 403 as an actionable HTTP error", async () => {
  const fetchImpl = fakeFetch([["/api/v1/widget/bootstrap", () => jsonResponse({ code: "1", msg: "Referer header is required" }, 403)]]);
  const client = new PharosDocsClient({ fetch: fetchImpl });
  await assert.rejects(
    () => client.bootstrap(),
    (err) => {
      assert.ok(err instanceof PharosError);
      assert.equal(err.status, 403);
      assert.match(err.message, /HTTP 403/);
      return true;
    },
  );
});

test("ask() resolves the Docs chat session, streams the answer and keeps the sources intact", async () => {
  const fetchImpl = fakeFetch(docsRoutes());
  const client = authedClient(fetchImpl);
  const reply = await client.ask("How do I deploy a contract?");

  assert.equal(reply.finished, true);
  assert.equal(reply.timedOut, false);
  assert.equal(reply.interrupted, false);
  assert.deepEqual(reply.errors, []);
  assert.equal(reply.agentType, AGENT_TYPES.DOCS);
  assert.match(reply.text, /npx hardhat ignition deploy/);
  assert.match(reply.text, /https:\/\/docs\.pharos\.xyz\/developer-guide\/hardhat\/write-your-first-dapp/);

  const chat = fetchImpl.call("/chat/completions");
  assert.equal(chat.body.spaceType, "pharos");
  assert.equal(chat.body.operationType, "chat");
  assert.equal(chat.body.agentType, "PHAROS_DOCS");
  assert.equal(chat.body.stream, true);
  assert.equal(chat.body.message, "How do I deploy a contract?");
  assert.equal(chat.body.sessionId, `pharos-agent-3f2504e0-4f89-11d3-9a0c-0305e82c3301`, "must use the agent chatSessionId, not the widget session");
  assert.equal(chat.headers.Accept, "text/event-stream");
  assert.equal(chat.headers.Origin, "https://ai.pharos.xyz");
});

test("ask() without a session refuses before touching the network", async () => {
  const fetchImpl = fakeFetch(docsRoutes());
  const client = new PharosDocsClient({ fetch: fetchImpl });
  await assert.rejects(
    () => client.ask("anything"),
    (err) => {
      assert.ok(err instanceof PharosError);
      assert.equal(err.kind, "auth");
      assert.match(err.hint, /--login/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("a 401 from the chat endpoint becomes an actionable auth error", async () => {
  const fetchImpl = fakeFetch(
    docsRoutes({ chatStatus: 401, chatBody: { code: "401", message: "Unauthorized, please login first" } }),
  );
  const client = authedClient(fetchImpl);
  await assert.rejects(
    () => client.ask("who am I?"),
    (err) => {
      assert.equal(err.kind, "auth");
      assert.equal(err.status, 401);
      assert.match(err.message, /Unauthorized, please login first/);
      assert.match(err.hint, /--login/);
      return true;
    },
  );
});

test("a connection failure is a network error, not a crash", async () => {
  const fetchImpl = () => Promise.reject(new TypeError("fetch failed"));
  const client = authedClient(fetchImpl);
  await assert.rejects(
    () => client.ask("hello"),
    (err) => {
      assert.equal(err.kind, "network");
      assert.match(err.message, /could not reach the Pharos documentation service/);
      assert.match(err.hint, /network/i);
      return true;
    },
  );
});

test("a stalled stream hits the deadline and keeps whatever streamed in first", async () => {
  const routes = docsRoutes();
  routes[routes.length - 1] = [
    "/chat/completions",
    () => stalledSseResponse(['data:{"choices":[{"delta":{"content":"partial"}}]}\n']),
  ];
  const client = authedClient(fakeFetch(routes), { streamTimeoutMs: 60 });
  const reply = await client.ask("slow question");
  assert.equal(reply.timedOut, true);
  assert.equal(reply.text, "partial");
  assert.equal(reply.finished, false);
});

test("a stalled stream that produced nothing is flagged as timed out with no text", async () => {
  const routes = docsRoutes();
  routes[routes.length - 1] = ["/chat/completions", () => stalledSseResponse([])];
  const client = authedClient(fakeFetch(routes), { streamTimeoutMs: 60 });
  const reply = await client.ask("slow question");
  assert.equal(reply.timedOut, true);
  assert.equal(reply.text, "");
});

test("a stream that ends without [DONE] is reported as interrupted", async () => {
  const routes = docsRoutes({ frames: interruptedFrames() });
  const client = authedClient(fakeFetch(routes));
  const reply = await client.ask("cut off question");
  assert.equal(reply.finished, false);
  assert.equal(reply.interrupted, true);
  assert.match(reply.text, /Fabricated partial answer/);
});

test("malformed frames inside an otherwise valid stream are skipped and counted", async () => {
  const frames = ['data:{"garbage"\n', ...answerFrames()];
  const client = authedClient(fakeFetch(docsRoutes({ frames })));
  const reply = await client.ask("question with a malformed frame");
  assert.equal(reply.stats.malformedFrames, 1);
  assert.equal(reply.finished, true);
  assert.match(reply.text, /hardhat ignition deploy/);
});

test("a service error frame is surfaced without discarding the stream", async () => {
  const client = authedClient(fakeFetch(docsRoutes({ frames: errorFrames() })));
  const reply = await client.ask("question that errors");
  assert.deepEqual(reply.errors, [{ code: "UPSTREAM_ERROR", message: "the document store is temporarily unavailable" }]);
  assert.equal(reply.text, "");
});

test("an empty response body is an operational error", async () => {
  const routes = docsRoutes();
  routes[routes.length - 1] = ["/chat/completions", () => new Response(null, { status: 200 })];
  const client = authedClient(fakeFetch(routes));
  await assert.rejects(
    () => client.ask("empty"),
    (err) => {
      assert.equal(err.kind, "stream");
      return true;
    },
  );
});

test("a malformed JSON control response is reported as an MCP error", async () => {
  const fetchImpl = fakeFetch([
    ["/api/v1/pharos/conversations/session/", () => new Response("<html>502</html>", { status: 200 })],
    ["/api/v1/pharos/conversations/session", () => new Response(JSON.stringify({ code: "000000", data: [{ sessionId: "s" }] }))],
  ]);
  const client = authedClient(fetchImpl);
  await assert.rejects(
    () => client.ask("who?"),
    (err) => {
      assert.equal(err.kind, "mcp");
      assert.match(err.message, /malformed JSON/);
      return true;
    },
  );
});

test("a session with no Docs agent is reported with the agents that are available", async () => {
  const fetchImpl = fakeFetch([
    ["/api/v1/pharos/conversations/session/", () => jsonResponse({ code: "000000", data: { agents: [{ agentType: "OTHER", chatSessionId: "x" }] } })],
    ["/api/v1/pharos/conversations/session", () => jsonResponse({ code: "000000", data: [{ sessionId: "s" }] })],
  ]);
  const client = authedClient(fetchImpl);
  await assert.rejects(
    () => client.ask("docs?"),
    (err) => {
      assert.equal(err.kind, "mcp");
      assert.match(err.hint, /OTHER/);
      return true;
    },
  );
});

test("a guest bootstrap with no access token is an explicit MCP error", async () => {
  const fetchImpl = fakeFetch([["/api/v1/widget/bootstrap", () => jsonResponse({ code: "000000", data: { tokenType: "GUEST" } })]]);
  const client = new PharosDocsClient({ fetch: fetchImpl });
  await assert.rejects(
    () => client.bootstrap(),
    (err) => {
      assert.equal(err.kind, "mcp");
      assert.match(err.message, /no access token/);
      return true;
    },
  );
});

test("the chat session ids are cached per client instance", async () => {
  const fetchImpl = fakeFetch(docsRoutes());
  const client = authedClient(fetchImpl);
  await client.ask("first");
  await client.ask("second");
  const listCalls = fetchImpl.calls.filter((c) => c.url.includes("/conversations/session") && !c.url.includes("/agents"));
  assert.equal(listCalls.length, 1, "the conversation list must be fetched once");
});

test("the bearer token never appears in the trace", async () => {
  /** @type {any[]} */
  const trace = [];
  const client = authedClient(fakeFetch(docsRoutes()), { onTrace: (e) => trace.push(e) });
  await client.ask("trace check");
  assert.ok(trace.length > 0);
  assert.ok(!JSON.stringify(trace).includes(FAKE_JWT));
  assert.match(String(trace.find((t) => t.kind === "chat.request").detail.authorization), /redacted/);
});

test("a custom agent id is forwarded verbatim", async () => {
  const fetchImpl = fakeFetch(docsRoutes());
  const client = authedClient(fetchImpl);
  await client.ask("chain question", { agentType: AGENT_TYPES.CHAIN_MCP });
  assert.equal(fetchImpl.call("/chat/completions").body.agentType, "PHAROS_MCP");
});
