import test from "node:test";
import assert from "node:assert/strict";
import {
  NO_ANSWER_MESSAGE,
  NO_SOURCE_NOTE,
  INTERRUPTED_STREAM_NOTE,
  PARTIAL_ANSWER_NOTE,
  assessAnswer,
} from "../src/answer.mjs";

const GOOD = {
  text: "Use the `pharos` network alias.\n\n**Source:** [Write Your First dApp](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)",
  errors: [],
  finished: true,
  timedOut: false,
  interrupted: false,
};

test("a supported answer is accepted and its source is preserved", () => {
  const result = assessAnswer(GOOD);
  assert.equal(result.status, "ok");
  assert.equal(result.reason, null);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp");
  assert.deepEqual(result.warnings, []);
});

test("an answer without any source link is reported, not invented", () => {
  const result = assessAnswer({ ...GOOD, text: "Pharos Atlantic Testnet has chain id 688689." });
  assert.equal(result.status, "ok");
  assert.equal(result.sources.length, 0);
  assert.deepEqual(result.warnings, [NO_SOURCE_NOTE]);
});

test("--require-sources turns a missing source into a no-answer", () => {
  const result = assessAnswer({ ...GOOD, text: "Pharos Atlantic Testnet has chain id 688689." }, { requireSources: true });
  assert.equal(result.status, "no-answer");
  assert.match(result.reason, /no-sources/);
  assert.equal(result.message, NO_ANSWER_MESSAGE);
});

test("a first-person inability answer is treated as insufficient", () => {
  const result = assessAnswer({ ...GOOD, text: "I don't have enough information about that." });
  assert.equal(result.status, "no-answer");
  assert.match(result.reason, /insufficient-answer/);
  assert.equal(result.message, NO_ANSWER_MESSAGE);
});

test("curly apostrophes do not defeat the insufficiency probes", () => {
  const result = assessAnswer({ ...GOOD, text: "I couldn\u2019t find that in the documentation." });
  assert.equal(result.status, "no-answer");
});

test("a negative finding that DOES cite documentation pages stays an answer", () => {
  // Verbatim shape of the live reply to the faucet question (2026-10-16): it reports a
  // documentation gap *and* cites the pages it summarised, so it is a real answer.
  const text = [
    "The documentation's faucet guidance is limited: the Piggy Bank Tutorial mentions a Pharos faucet",
    "but does not include a public faucet URL, and the Get PROS Gas page covers mainnet only.",
    "",
    "1. **[Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)** — network parameters",
    "2. **[Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)** — mainnet PROS acquisition",
  ].join("\n");
  const result = assessAnswer({ ...GOOD, text });
  assert.equal(result.status, "ok");
  assert.equal(result.pharosSources.length, 2);
});

test("'the documentation does not contain this' with no Pharos docs link is a no-answer", () => {
  // Verbatim opening of the live reply to "what was the USD closing price of PROS yesterday?"
  // (2026-10-16) — the service cited only binance.com and pharosscan.xyz.
  const text =
    "The Pharos developer documentation does not contain cryptocurrency price data, including PROS trading prices on Binance or any other exchange.\n\n" +
    "For PROS price information, check [Binance](https://www.binance.com) directly.";
  const result = assessAnswer({ ...GOOD, text });
  assert.equal(result.status, "no-answer");
  assert.equal(result.reason, "documentation-does-not-cover");
  assert.equal(result.message, NO_ANSWER_MESSAGE);
  // the service's own words are preserved for --json / --debug, not used to fabricate a source
  assert.match(result.answer, /does not contain cryptocurrency price data/);
  assert.deepEqual(result.sources.map((s) => s.host), ["www.binance.com"]);
});

test("'not documented in the docs' with no Pharos docs link is a no-answer", () => {
  const result = assessAnswer({ ...GOOD, text: "That feature is not mentioned in the Pharos documentation." });
  assert.equal(result.status, "no-answer");
  assert.match(result.reason, /documentation-does-not-cover|insufficient-answer/);
});

test("an empty response with no timeout is a no-answer", () => {
  const result = assessAnswer({ text: "", errors: [], finished: true });
  assert.equal(result.status, "no-answer");
  assert.equal(result.reason, "empty-response");
  assert.equal(result.message, NO_ANSWER_MESSAGE);
});

test("a deadline that produced nothing is an operational error, not a no-answer", () => {
  const result = assessAnswer({ text: "", errors: [], finished: false, timedOut: true });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "timeout-no-content");
  assert.match(result.hint, /--timeout/);
});

test("a stream cut off before any answer is an operational error", () => {
  const result = assessAnswer({ text: "", errors: [], finished: false, interrupted: true });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "interrupted-stream-no-content");
});

test("a partial answer is kept and flagged", () => {
  const result = assessAnswer({ ...GOOD, timedOut: true });
  assert.equal(result.status, "ok");
  assert.ok(result.warnings.includes(PARTIAL_ANSWER_NOTE));
});

test("an answer from a stream without an end frame is kept and flagged", () => {
  const result = assessAnswer({ ...GOOD, finished: false, interrupted: true });
  assert.equal(result.status, "ok");
  assert.ok(result.warnings.includes(INTERRUPTED_STREAM_NOTE));
});

test("a service-side error frame fails the run even when text arrived first", () => {
  const result = assessAnswer({ ...GOOD, errors: [{ code: "UPSTREAM_ERROR", message: "store unavailable" }] });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "stream-error");
  assert.match(result.message, /UPSTREAM_ERROR/);
  assert.match(result.message, /store unavailable/);
  // the partial text is retained for --json / --debug, never discarded
  assert.ok(result.answer.length > 0);
});
