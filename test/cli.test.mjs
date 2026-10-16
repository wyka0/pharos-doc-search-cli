import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "../src/cli.mjs";
import { NO_ANSWER_MESSAGE } from "../src/answer.mjs";
import { EXIT } from "../src/errors.mjs";
import {
  FAKE_JWT,
  answerFrames,
  captureIo,
  docsRoutes,
  errorFrames,
  fakeFetch,
  interruptedFrames,
  jsonResponse,
  sseResponse,
  stalledSseResponse,
  tempDir,
  tempSessionFile,
  vagueFrames,
  missingSessionFile,
} from "./helpers/mock.mjs";

/** Run the CLI with mocked network + a fabricated cached session. */
async function run(argv, { routes = docsRoutes(), session, env = {} } = {}) {
  const fetchImpl = fakeFetch(routes);
  const captured = captureIo();
  const state = session ?? (await tempSessionFile());
  const code = await runCli(argv, {
    fetch: fetchImpl,
    io: captured.io,
    env: { PHAROS_STATE_FILE: state.file, ...env },
  });
  return { code, out: captured.out(), err: captured.err(), fetchImpl, state };
}

const QUESTION = "How do I deploy a smart contract to Pharos?";

test("--help exits 0 and documents the exit codes", async () => {
  const { code, out } = await run(["--help"], { routes: [] });
  assert.equal(code, EXIT.OK);
  assert.match(out, /USAGE/);
  assert.match(out, /EXIT CODES/);
  assert.match(out, /no reliable answer found/i);
});

test("--version exits 0 and prints the package version", async () => {
  const { code, out } = await run(["--version"], { routes: [] });
  assert.equal(code, EXIT.OK);
  assert.match(out.trim(), /^pharos-docs \d+\.\d+\.\d+$/);
});

test("a usage error exits 4 and explains the problem", async () => {
  const { code, err } = await run([], { routes: [] });
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /no question provided/);
  assert.match(err, /--help/);
});

test("a whitespace-only question exits 4", async () => {
  const { code, err } = await run(["   "], { routes: [] });
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /empty/);
});

test("unknown flags and invalid values exit 4", async () => {
  for (const argv of [["--nope", "q"], ["--agent", "NOPE", "q"], ["--timeout", "abc", "q"], ["--timeout", "q"]]) {
    const { code } = await run(argv, { routes: [] });
    assert.equal(code, EXIT.USAGE, `expected usage error for ${argv.join(" ")}`);
  }
});

test("--login combined with a question exits 4", async () => {
  const { code, err } = await run(["--login", "what?"], { routes: [] });
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /cannot be combined/);
});

test("a supported question prints the answer and the source links the service returned", async () => {
  const { code, out, err, fetchImpl } = await run([QUESTION]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /npx hardhat ignition deploy/);
  assert.match(out, /Sources the Docs MCP returned \(3\)/);
  assert.match(out, /docs\.pharos\.xyz \(2\):/);
  assert.match(out, /other hosts mentioned in the answer \(1\):/);
  assert.match(out, /https:\/\/docs\.pharos\.xyz\/developer-guide\/hardhat\/write-your-first-dapp/);
  assert.match(out, /https:\/\/docs\.pharos\.xyz\/getting-started\/network\/atlantic-testnet/);
  assert.match(out, /https:\/\/hardhat\.org\/hardhat-runner\/docs\/getting-started#installation/);
  assert.equal(err, "");
  assert.equal(fetchImpl.call("/chat/completions").body.message, QUESTION);
});

test("--json returns one parseable object with preserved sources and exit code", async () => {
  const { code, out } = await run(["--json", QUESTION]);
  assert.equal(code, EXIT.OK);
  const payload = JSON.parse(out);
  assert.equal(payload.tool, "pharos-docs");
  assert.equal(payload.status, "ok");
  assert.equal(payload.question, QUESTION);
  assert.equal(payload.sourceCount, 3);
  assert.deepEqual(
    payload.sources.map((s) => s.url),
    [
      "https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp",
      "https://docs.pharos.xyz/getting-started/network/atlantic-testnet",
      "https://hardhat.org/hardhat-runner/docs/getting-started#installation",
    ],
  );
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.auth.source, "file");
  assert.equal(payload.finished, true);
});

test("several unquoted words are joined into one question", async () => {
  const { code, out } = await run(["--json", "how", "do", "I", "deploy?"]);
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(out).question, "how do I deploy?");
});

test("an unsupported question exits 2 with the documented no-answer message", async () => {
  const { code, out, err } = await run(["What is the capital of France?"], {
    routes: docsRoutes({ frames: vagueFrames() }),
  });
  assert.equal(code, EXIT.NO_ANSWER);
  assert.ok(out.includes(NO_ANSWER_MESSAGE), "the exact no-answer message must be printed");
  assert.match(err, /detail:/);
});

test("--json reports the no-answer status and exit code 2", async () => {
  const { code, out } = await run(["--json", "What is the capital of France?"], {
    routes: docsRoutes({ frames: vagueFrames() }),
  });
  assert.equal(code, EXIT.NO_ANSWER);
  const payload = JSON.parse(out);
  assert.equal(payload.status, "no-answer");
  assert.equal(payload.message, NO_ANSWER_MESSAGE);
  assert.equal(payload.sources.length, 0);
  assert.equal(payload.exitCode, 2);
});

test("--require-sources turns an unsourced answer into exit 2", async () => {
  const frames = ['data:{"choices":[{"delta":{"content":"Pharos Atlantic Testnet has chain id 688689."}}]}\n', "data:[DONE]\n"];
  const plain = await run([QUESTION], { routes: docsRoutes({ frames }) });
  assert.equal(plain.code, EXIT.OK);
  assert.match(plain.out, /no source link was returned/i);

  const strict = await run(["--require-sources", QUESTION], { routes: docsRoutes({ frames }) });
  assert.equal(strict.code, EXIT.NO_ANSWER);
  assert.match(strict.out, /No reliable answer found/);
});

test("not being signed in exits 3 before any network call, with a login hint", async () => {
  const missing = await missingSessionFile();
  const fetchImpl = fakeFetch(docsRoutes());
  const captured = captureIo();
  const code = await runCli([QUESTION], {
    fetch: fetchImpl,
    io: captured.io,
    env: { PHAROS_STATE_FILE: missing.file },
  });
  assert.equal(code, EXIT.OPERATIONAL);
  assert.match(captured.err(), /not signed in/);
  assert.match(captured.err(), /--login/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("an expired/refused session exits 3 and points at --login", async () => {
  const { code, err } = await run([QUESTION], {
    routes: docsRoutes({ chatStatus: 401, chatBody: { code: "401", message: "Unauthorized, please login first" } }),
  });
  assert.equal(code, EXIT.OPERATIONAL);
  assert.match(err, /HTTP 401/);
  assert.match(err, /--login/);
});

test("a network failure exits 3 with an actionable message", async () => {
  const captured = captureIo();
  const session = await tempSessionFile();
  const code = await runCli([QUESTION], {
    fetch: () => Promise.reject(new TypeError("fetch failed")),
    io: captured.io,
    env: { PHAROS_STATE_FILE: session.file },
  });
  assert.equal(code, EXIT.OPERATIONAL);
  assert.match(captured.err(), /could not reach the Pharos documentation service/);
  assert.match(captured.err(), /hint:/);
});

test("a stalled stream exits 3 when nothing arrived", async () => {
  const { code, err } = await run(["--timeout", "0.05", QUESTION], {
    routes: docsRoutes({ chatResponder: () => stalledSseResponse([]) }),
  });
  assert.equal(code, EXIT.OPERATIONAL);
  assert.match(err, /did not start answering|did not finish responding/);
});

test("a stalled stream that produced text exits 0 with a partial-answer note", async () => {
  const { code, out } = await run(["--timeout", "0.05", QUESTION], {
    routes: docsRoutes({
      chatResponder: () => stalledSseResponse(['data:{"choices":[{"delta":{"content":"Partial answer text."}}]}\n']),
    }),
  });
  assert.equal(code, EXIT.OK);
  assert.match(out, /Partial answer text/);
  assert.match(out, /cut short by the client-side stream deadline/);
});

test("a stream error frame exits 3 and names the service error", async () => {
  const { code, err } = await run([QUESTION], { routes: docsRoutes({ frames: errorFrames() }) });
  assert.equal(code, EXIT.OPERATIONAL);
  assert.match(err, /UPSTREAM_ERROR/);
  assert.match(err, /hint:/);
});

test("a stream that ends without an end frame exits 0 with a warning note", async () => {
  const { code, out } = await run([QUESTION], { routes: docsRoutes({ frames: interruptedFrames() }) });
  assert.equal(code, EXIT.OK);
  assert.match(out, /ended unexpectedly/);
  assert.match(out, /Fabricated partial answer/);
});

test("--debug never prints the bearer token or the session id", async () => {
  const { code, err } = await run(["--debug", QUESTION]);
  assert.equal(code, EXIT.OK);
  assert.ok(err.includes("--- debug (secrets redacted) ---"));
  assert.ok(!err.includes(FAKE_JWT));
  assert.ok(!err.includes("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
  assert.match(err, /"authorization":"<redacted>"/);
});

test("--json --debug nests redacted debug data", async () => {
  const { out } = await run(["--json", "--debug", QUESTION]);
  const payload = JSON.parse(out);
  assert.ok(payload.debug);
  assert.ok(payload.debug.frames.length > 0);
  assert.ok(!JSON.stringify(payload.debug).includes(FAKE_JWT));
  assert.equal(typeof payload.debug.stats.dataFrames, "number");
});

test("--json reports operational errors as a machine-readable object", async () => {
  const { code, out, err } = await run(["--json", QUESTION], {
    routes: docsRoutes({ chatStatus: 500, chatBody: { code: "500", message: "internal" } }),
  });
  assert.equal(code, EXIT.OPERATIONAL);
  const payload = JSON.parse(out);
  assert.equal(payload.status, "error");
  assert.equal(payload.error.kind, "http");
  assert.equal(payload.error.httpStatus, 500);
  assert.equal(payload.exitCode, 3);
  assert.equal(err, "");
});

test("PHAROS_ACCESS_TOKEN is used when no session file exists and is never printed", async () => {
  const missing = await missingSessionFile();
  const captured = captureIo();
  const fetchImpl = fakeFetch(docsRoutes());
  const code = await runCli(["--json", QUESTION], {
    fetch: fetchImpl,
    io: captured.io,
    env: { PHAROS_STATE_FILE: missing.file, PHAROS_ACCESS_TOKEN: FAKE_JWT },
  });
  assert.equal(code, EXIT.OK);
  const payload = JSON.parse(captured.out());
  assert.equal(payload.auth.source, "env");
  assert.ok(!captured.out().includes(FAKE_JWT));
  assert.equal(fetchImpl.call("/chat/completions").headers.Authorization, `Bearer ${FAKE_JWT}`);
});

test("--login performs the handshake, caches the session and never prints the token", async () => {
  const dir = await tempDir();
  const stateFile = path.join(dir, "session.json");
  const walletFile = path.join(dir, "wallet.json");
  const routes = [
    ["/api/v1/widget/bootstrap", () => jsonResponse(guestBootstrap())],
    [
      "/api/v1/widget/wallet/challenge",
      () => jsonResponse({ code: "000000", data: { challengeId: "challenge-1", message: "Sign in to Pharos (fabricated)", expiresAt: "2099-01-01T00:00:00Z" } }),
    ],
    [
      "/api/v1/widget/agentcenter/wallet/verify",
      () =>
        jsonResponse({
          code: "000000",
          data: { accessToken: FAKE_JWT, tokenType: "AUTHENTICATED", expiresAt: "2099-01-01T00:00:00Z", session: { id: "session-1", remainingQuota: 300 } },
        }),
    ],
    ["/api/v1/widget/onboarding/status", () => jsonResponse({ code: "000000", data: { state: "FULL_READY", nextAction: "COMPLETE_ONBOARDING" } })],
    [
      "/api/v1/widget/agentcenter/onboarding/complete",
      () => jsonResponse({ code: "000000", data: { state: "COMPLETE", accessToken: FAKE_JWT, tokenType: "AUTHENTICATED", expiresAt: "2099-01-01T00:00:00Z" } }),
    ],
  ];
  const fetchImpl = fakeFetch(routes);
  const captured = captureIo();
  const code = await runCli(["--login", "--state-file", stateFile, "--wallet-file", walletFile], {
    fetch: fetchImpl,
    io: captured.io,
    env: {},
  });

  assert.equal(code, EXIT.OK);
  assert.match(captured.out(), /Signed in\./);
  assert.ok(!captured.out().includes(FAKE_JWT), "the token must never be printed");

  const written = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(written.accessToken, FAKE_JWT);
  assert.equal(written.tokenType, "AUTHENTICATED");
  assert.match(written.address, /^0x[0-9a-fA-F]{40}$/);

  const wallet = JSON.parse(await readFile(walletFile, "utf8"));
  assert.match(wallet.privateKey, /^0x[0-9a-f]{64}$/);
  assert.ok(!captured.err().includes(wallet.privateKey), "the private key must never be printed");
});

/** The fabricated guest bootstrap body used by the login test. */
function guestBootstrap() {
  return {
    code: "000000",
    success: true,
    data: {
      config: { supportedChains: ["5734951"] },
      accessToken: "eyJhbGciOiJIUzI1NiJ9.guest-fake.sig",
      tokenType: "GUEST",
      expiresAt: "2099-01-01T00:00:00Z",
      session: { id: "widget-1", remainingQuota: 10 },
    },
  };
}

test("the standard fixture answer is non-empty (guards the suite against an empty fixture)", () => {
  assert.ok(answerFrames().length > 4);
  assert.ok(sseResponse(answerFrames()) instanceof Response);
});
