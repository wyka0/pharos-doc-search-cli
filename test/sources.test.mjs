import test from "node:test";
import assert from "node:assert/strict";
import { extractSources, formatSourceLines, hostOfUrl, isPharosDocsHost } from "../src/sources.mjs";
import { answerFrames } from "./helpers/mock.mjs";
import { collectReply, createSseDecoder } from "../src/sse.mjs";

/** Build the answer text from the fabricated SSE fixture. */
function fixtureAnswer() {
  const decoder = createSseDecoder();
  const events = [...answerFrames().flatMap((frame) => decoder.push(frame)), ...decoder.flush()];
  return collectReply(events).text;
}

test("source references are extracted and preserved byte for byte", () => {
  const { sources } = extractSources(
    "**Source:** [Write Your First dApp (Hardhat)](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)",
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, "Write Your First dApp (Hardhat)");
  assert.equal(sources[0].url, "https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp");
  assert.equal(sources[0].host, "docs.pharos.xyz");
  assert.equal(sources[0].pharosDocs, true);
});

test("URLs with fragments and query strings are not rewritten", () => {
  const url = "https://hardhat.org/hardhat-runner/docs/getting-started#installation";
  const { sources } = extractSources(`See [hardhat.org](${url}).`);
  assert.equal(sources[0].url, url);
  assert.equal(sources[0].pharosDocs, false);
});

test("the real fabricated answer yields three sources, Pharos docs first", () => {
  const { sources, pharosDocs, external } = extractSources(fixtureAnswer());
  assert.equal(sources.length, 3);
  assert.deepEqual(
    pharosDocs.map((s) => s.url),
    [
      "https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp",
      "https://docs.pharos.xyz/getting-started/network/atlantic-testnet",
    ],
  );
  assert.deepEqual(external.map((s) => s.url), ["https://hardhat.org/hardhat-runner/docs/getting-started#installation"]);
});

test("duplicate references are listed once, in first-seen order", () => {
  const { sources } = extractSources(
    [
      "- [Network](https://docs.pharos.xyz/getting-started)",
      "- [Network again](https://docs.pharos.xyz/getting-started)",
      "- [Network with slash](https://docs.pharos.xyz/getting-started/)",
    ].join("\n"),
  );
  assert.deepEqual(
    sources.map((s) => s.url),
    ["https://docs.pharos.xyz/getting-started"],
  );
});

test("images and code-fence examples are not treated as citations", () => {
  const text = [
    "![logo](https://docs.pharos.xyz/assets/logo.png)",
    "```shell",
    "git clone https://github.com/PharosNetwork/examples",
    "```",
    "Source: [Wallets](https://docs.pharos.xyz/tooling-and-infrastructure/wallets)",
  ].join("\n");
  const { sources } = extractSources(text);
  assert.deepEqual(
    sources.map((s) => s.url),
    ["https://docs.pharos.xyz/tooling-and-infrastructure/wallets"],
  );
});

test("bare URLs outside code fences are captured", () => {
  const { sources } = extractSources("Mainnet gas: https://port.pharos.xyz/get-pros. Then stop.");
  assert.deepEqual(
    sources.map((s) => s.url),
    ["https://port.pharos.xyz/get-pros"],
  );
});

test("an answer with no links yields no sources (nothing is invented)", () => {
  const { sources, urls } = extractSources("Pharos is a layer-1 network. No links here.");
  assert.deepEqual(sources, []);
  assert.deepEqual(urls, []);
});

test("host helpers classify Pharos documentation hosts", () => {
  assert.equal(hostOfUrl("https://docs.pharos.xyz/a"), "docs.pharos.xyz");
  assert.equal(hostOfUrl("not a url"), "");
  assert.equal(isPharosDocsHost("docs.pharos.xyz"), true);
  assert.equal(isPharosDocsHost("docs.pharos.xyz.example.com"), false);
  assert.equal(isPharosDocsHost("mcp.pharos.xyz"), false);
});

test("formatSourceLines numbers the references", () => {
  const { sources } = extractSources("[A](https://docs.pharos.xyz/a) and [B](https://example.invalid/b)");
  assert.deepEqual(formatSourceLines(sources), [
    "  1. A — https://docs.pharos.xyz/a",
    "  2. B — https://example.invalid/b",
  ]);
  assert.deepEqual(formatSourceLines(sources, "    "), [
    "    1. A — https://docs.pharos.xyz/a",
    "    2. B — https://example.invalid/b",
  ]);
});
