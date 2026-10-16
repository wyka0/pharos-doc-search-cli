# Verified output

Everything in this file was **executed** on **2026-10-16** on Windows 11 with Node `v24.14.1`,
npm `11.11.0` and git `2.53.0.windows.2`. Commands are quoted as run and results as printed.
Nothing here is illustrative; where a first attempt failed or a behaviour turned out to be wrong,
that is recorded rather than hidden.

Two classes of result appear below and are labelled explicitly:

- **Mocked** — from `npm test`, which uses fabricated fixtures and no network at all.
- **Live** — from the real Pharos Docs MCP at `ai.pharos.xyz` (only §4, §5 and §6).

---

## 1. Install, static check and unit tests

```text
$ npm ci
added 13 packages in 2m

$ npm run check
21/21 files passed syntax check.

$ npm test
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ duration_ms 4856.5147
```

`npm ci` installs from `package-lock.json`; the only runtime dependency is `viem@2.57.7`, used
solely to generate and sign with the local throwaway wallet during `--login`. `npm run check` is a
plain `node --check` pass over every module in `bin/`, `src/`, `test/` and `scripts/` — no linter or
formatter is configured, so the *mocked* suite plus this syntax gate **is** the project's static
gate. There is no build step (`bin/` and `src/` are shipped as-is), so package validation is the
`npm ci` + `npm test` round trip plus the child-process tests in §3.

### Honest notes on the test suite

- One test failed when first written: `--debug` output was asserted to contain `Bearer <redacted>`,
  but the request trace records the header as JSON (`"authorization":"<redacted>"`). The assertion
  was corrected to match the real output (`test/cli.test.mjs`). No production code changed.
- After the **live** run in §4 revealed a case the policy got wrong, two tests were added
  (`test/answer.test.mjs`), taking the count from 84 to 86; the fixture-completeness guard described
  below took it to 87. See §4.1 — the failure is documented there in full.
- A real packaging bug was found during the secret/sensitive-file scan: `.gitignore` contained a bare
  `session.json` pattern (intended for local state), which also excluded the tracked fixture
  `test/fixtures/session.json`. The file existed locally, so `npm test` passed here — but a fresh
  clone would have been missing a fixture. The pattern is now root-anchored (`/session.json`) and a
  regression test asserts that every fixture the suite depends on is present
  (`test/redact.test.mjs`, test 87). This is exactly the kind of failure the clean-clone check below
  exists to catch.

### Clean-clone verification

```text
$ git clone <this repository> …\clone-check
$ cd …\clone-check && npm ci && npm run check && npm test
HEAD=6c7bb3e
files=36
added 13 packages in 3m
21/21 files passed syntax check.
ℹ tests 87
ℹ pass 87
ℹ fail 0

$ node bin/pharos-docs.mjs --version
pharos-docs 1.0.0

$ node bin/pharos-docs.mjs "How do I deploy a contract?"
error: not signed in to the Pharos Docs MCP
hint: Anonymous guest sessions are refused by the Docs MCP (HTTP 401). Run `pharos-docs --login` once, or set PHAROS_ACCESS_TOKEN.
exit=3

$ node bin/pharos-docs.mjs --json "How do I deploy a contract?"
{
  "tool": "pharos-docs",
  "version": "1.0.0",
  "question": "How do I deploy a contract?",
  "status": "error",
  "error": {
    "kind": "auth",
    "message": "not signed in to the Pharos Docs MCP",
    "hint": "Anonymous guest sessions are refused by the Docs MCP (HTTP 401). Run `pharos-docs --login` once, or set PHAROS_ACCESS_TOKEN.",
    "httpStatus": null,
    "code": null
  },
  "exitCode": 3
}
exit=3
```

This proves three things a local run cannot: every fixture the suite needs is actually tracked, no
test depends on local authentication state (`.local/` is absent), and a first-time user with no
session gets an actionable message and exit code 3 instead of a stack trace.

### Coverage of the mocked suite (87 tests, 7 files)

| File | What it pins down |
| --- | --- |
| `test/sse.test.mjs` (7) | chunk boundaries, CRLF, comment/heartbeat lines, `event:`/`id:` fields, malformed JSON frames (skipped and counted), final partial line, interrupted stream, `[DONE]` |
| `test/sources.test.mjs` (9) | byte-for-byte URL preservation, fragments/query strings, multi-link answers, dedup order, images and code-fence examples excluded, bare URLs, empty source list, host classification, formatting |
| `test/answer.test.mjs` (14) | the whole decision table: supported answer, no-source note, `--require-sources`, first-person inability, curly apostrophes, documentation-gap vs. answer-with-gap, empty text, deadline, interrupted stream, partial answer, service error frame |
| `test/redact.test.mjs` (7) | JWTs, UUIDs, bearer headers, 32-byte hex keys, nested credential keys, header records, fixture redaction, fixture-completeness guard |
| `test/client.test.mjs` (18) | bootstrap headers/body, 403 mapping, chat session resolution (widget session rejected), body/header contract, no-session refusal, 401 mapping, network rejection, deadline with and without text, interrupted stream, malformed frames, error frames, empty body, malformed JSON control response, missing agent, session-id caching, token never traced, custom agent id |
| `test/cli.test.mjs` (25) | help/version/usage errors, answer + grouped sources, `--json`, joined positional words, no-answer (exit 2), `--require-sources`, not-signed-in (exit 3), 401, network failure, timeout with/without text, error frame, interrupted stream, `--debug` redaction, `--json --debug`, machine-readable errors, `PHAROS_ACCESS_TOKEN`, the whole `--login` handshake incl. secret-free output |
| `test/cli-process.test.mjs` (7) | the real `bin/pharos-docs.mjs` in a child process: argv forwarding, stdout/stderr separation, exit codes 0/3/4, `--json` on a missing session |

## 2. CLI contract checks (no network)

```text
$ node bin/pharos-docs.mjs --help
pharos-docs — ask the Pharos Developer Docs MCP a question
…
EXIT CODES
  0  answered (with or without source links — see the note in the output)
  2  no reliable answer found in the available Pharos documentation
  3  operational error (authentication, network, timeout, MCP/protocol failure)
  4  usage error (bad arguments or an empty question)
…
EXIT=0
```

| Command | Exit | Observed |
| --- | --- | --- |
| `--help` | 0 | help on stdout, nothing on stderr |
| `--version` | 0 | `pharos-docs 1.0.0` |
| *(no arguments)* | 4 | `error: no question provided` + hint + `Run \`pharos-docs --help\` for usage.` |
| `"   "` | 4 | `error: the question is empty` |
| `--frobnicate hello` | 4 | `error: unknown option "--frobnicate"` |
| `--agent NOPE q` | 4 | `error: unknown agent "NOPE"` + valid list |
| `--timeout abc q` | 4 | `error: --timeout must be a positive number of seconds (got "abc")` |
| `--login "what?"` | 4 | `error: --login cannot be combined with a question` |
| *(question, no session)* | 3 | `error: not signed in to the Pharos Docs MCP` + `hint: … Run \`pharos-docs --login\` once, or set PHAROS_ACCESS_TOKEN.` |
| `--json` *(question, no session)* | 3 | one JSON object: `{"status":"error","error":{"kind":"auth",…},"exitCode":3}` |
| those same cases via `node bin/pharos-docs.mjs` in a child process | 0/3/4 | identical (see `test/cli-process.test.mjs`) |

Every one of these paths returns **before** any network call: the "no session" runs make zero HTTP
requests (asserted in `test/cli.test.mjs`).

## 3. Live authentication

The Docs MCP rejects anonymous guest sessions, so `--login` was run once with a **new throwaway
wallet generated by this project** (`.local/wallet.json`, git-ignored). Address truncated for this
document; the private key is never printed or committed.

```text
$ node bin/pharos-docs.mjs --login
Signing in to the Pharos Agent Center with a local throwaway wallet (no funds needed) …
Signed in.
  address:    0x3c52…cff9
  chainId:    5734951
  token type: AUTHENTICATED
  expires at: 2026-10-17T17:45:38Z
  session:    cached at .local/session.json (git-ignored; the token is never printed)
```

- `address` is printed **truncated here only**; the CLI prints it in full. It is a throwaway EOA with
  no funds on any network — it was used exclusively for `personal_sign`, never a transaction.
- No token, private key or session id appears in the output (or anywhere else) — asserted by
  `test/redact.test.mjs` and `test/cli.test.mjs`.
- The token is `AUTHENTICATED`, i.e. the onboarding state machine reached its terminal state. On a
  brand-new account the handshake also signs one EIP-712 guardian claim (`--debug` prints each step).

## 4. Live Docs MCP queries (the README examples)

Run from this repository against the real service, `--timeout 240`, one process per question.
Outputs are stored verbatim in the README; the table below records the **actual** run metadata:

| # | Question (short) | Exit | Answer chars | docs.pharos.xyz refs | Total refs | Time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Pacific Mainnet RPC + chain ID | **0** | 798 | 1 | 3 | 12.7 s |
| 2 | Deploy a contract with Hardhat | **0** | 2967 | 2 | 5 | 83.8 s |
| 3 | Test network + faucet situation | **0** | 2569 | 4 | 7 | 99.5 s |
| 4 | PROS market price "according to the docs" | **2** | 1277 (kept in `--json`) | 0 | 2 (first run) / 0 (re-run) | 15.0 s |

Row 4 is the only one whose exit code changed between runs: the first attempt returned **0** and the
policy was corrected (see §4.1). Rows 1–3 are the README captures. The re-run of row 4, quoted
verbatim in §4.1, took 15.0 s and exited 2.

All four questions returned `finished: true`, no stream errors, no malformed frames, and no
client-side timeout. Latency (12.7–99.5 s) is consistent with the 30–150 s range recorded in the
reference project, which is why the default deadline is 300 s.

### 4.1 The first attempt at example 4 was wrong — and the policy was fixed

The first live run of example 4 returned **exit 0**. The service had replied:

```text
The Pharos developer documentation does not contain cryptocurrency price data, including PROS
trading prices on Binance or any other exchange. … For PROS price information, you would need to
check: [Binance](https://www.binance.com) directly …
```

with only `https://www.binance.com` and `https://www.pharosscan.xyz` as links. The tool classified
this as an answer because the answer-quality policy only recognised *first-person* inability
phrasing. That is the wrong outcome for a documentation-search tool: the reply states the
documentation does not cover the question and cites no documentation page.

**Fix:** a new rule treats a *documentation-gap statement* as a no-answer **only when the service
also returned no `docs.pharos.xyz` reference**. A richer answer that mentions a gap *and* cites the
pages it summarised stays an answer (example 3 proves this case: it reports limited faucet
documentation while citing 4 Pharos docs pages, and still exits 0). Two tests were added for exactly
these two situations.

Re-run after the fix:

```text
$ node bin/pharos-docs.mjs --timeout 240 "According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?"
Question: According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?

No reliable answer found in the available Pharos documentation. Try a more specific question.
EXIT=2

stderr:
detail: documentation-does-not-cover
```

The service's own wording is **not discarded**: it remains available through `--json` (`answer` and
`sources` fields) and `--debug`, as shown in the README.

### 4.2 An accidental live probe: a nonsensical question

While re-running the smoke test, a harness mistake invoked the CLI with `scripts/live-smoke.mjs` as
the *question*. The service answered off-topic (it described a "workspace" and listed directories
that have nothing to do with Pharos), cited no links, and the CLI printed the answer with:

```text
Sources: none.
note: No source link was returned by the documentation service for this answer, so no reference can be shown.
```

Exit code **0**. This is the documented behaviour — "say that no source link was returned instead of
inventing one" — and it is recorded here because it is a genuine limitation: **a nonsensical question
can produce a plausible-looking, off-topic answer with no references.** The tool reports it as an
answer with an explicit "no source" note, and `--require-sources` turns any such answer into exit 2.
Both live behaviours (exit 0 with the note, and exit 2 under `--require-sources`) are covered by
mocked tests.

## 5. Live smoke test (`npm run smoke`)

```text
$ npm run smoke            # → node scripts/live-smoke.mjs --timeout 240
PASS  [What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used.] exit code 0 (got 0, 13.3s)
PASS    answer present (401 chars)
      **Pharos Pacific Mainnet**
      
      | Parameter | Value |
      |---|---|
      | **RPC URL** | `https://rpc.pharos.xyz` |
      | **Chain ID** | `1672` |
      | Native token | PROS |
      | Block Explorer | `https://www.pharosscan.xyz`
PASS    source links preserved (4)
      https://docs.pharos.xyz/getting-started/network/pacific-mainnet
      https://docs.pharos.xyz/~gitbook/mcp
      https://rpc.pharos.xyz
      https://www.pharosscan.xyz
PASS    at least one docs.pharos.xyz reference (2)
PASS    no credential leaked into stdout
PASS  [How do I deploy a smart contract to Pharos with Hardhat? Give the exact commands and the documentation page.] exit code 0 (got 0, 19.4s)
PASS    answer present (1887 chars)
      Here's how to deploy a smart contract to Pharos with Hardhat:
      
      ---
      
      ### Step 1 — Clone the example project
      
      ```shell
      git clone https://github.com/PharosNetwork/examples
      cd examples/dapp/hardhat
      npm in
PASS    source links preserved (3)
      https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp
      https://docs.pharos.xyz/~gitbook/mcp
      https://rpc.pharos.xyz
PASS    at least one docs.pharos.xyz reference (2)
PASS    no credential leaked into stdout
PASS  [Which network should a developer use for testing on Pharos, and what is its faucet situation according to the documentation?] exit code 0 (got 0, 19.1s)
PASS    answer present (1686 chars)
      ## Test Network: Atlantic Testnet
      
      Developers should use **Atlantic Testnet** for testing on Pharos.
      
      | Parameter | Value |
      |---|---|
      | **Network** | Atlantic Testnet |
      | **Chain ID** | `688689` |
      | *
PASS    source links preserved (7)
      https://docs.pharos.xyz/getting-started/network/atlantic-testnet
      https://docs.pharos.xyz/getting-started/get-pros-gas
      https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide
      https://docs.pharos.xyz/~gitbook/mcp
      https://port.pharos.xyz/get-pros
      https://atlantic.dplabs-internal.com
      https://atlantic.pharosscan.xyz/
PASS    at least one docs.pharos.xyz reference (4)
PASS    no credential leaked into stdout
PASS  [According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?] exit code 2 (got 2, 13.4s)
PASS    no-answer status
      No reliable answer found in the available Pharos documentation. Try a more specific question.
PASS    no source links invented
      []
PASS    no credential leaked into stdout

pharos-docs 1.0.0 — live smoke summary
[
  {
    "question": "What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used.",
    "code": 0,
    "seconds": 13.3,
    "status": "ok",
    "sourceCount": 4
  },
  {
    "question": "How do I deploy a smart contract to Pharos with Hardhat? Give the exact commands and the documentation page.",
    "code": 0,
    "seconds": 19.4,
    "status": "ok",
    "sourceCount": 3
  },
  {
    "question": "Which network should a developer use for testing on Pharos, and what is its faucet situation according to the documentation?",
    "code": 0,
    "seconds": 19.1,
    "status": "ok",
    "sourceCount": 7
  },
  {
    "question": "According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?",
    "code": 2,
    "seconds": 13.4,
    "status": "no-answer",
    "sourceCount": 0
  }
]

ALL LIVE CHECKS PASSED
```

**11/11 assertions passed, exit 0.** The harness prints each answer excerpt truncated to ~200
characters, which is why the excerpts above stop mid-sentence.

Notes on this run, stated plainly:

- This was a **second** live run; the answers differ in length from the README captures
  (401 vs 798 chars, 1887 vs 2967, 1686 vs 2569) and the no-answer reply cited **no** URLs at all
  this time (`sourceCount: 0`), whereas the README's example-4 run returned `binance.com` and
  `pharosscan.xyz`. Both are correct outcomes for the same code: the service's prose varies, and the
  no-answer rule keys on the *absence of a Pharos documentation reference*, not on a link count.
- The `no source links invented` label above was the assertion at the time of the run
  (`sources.length === 0`). It was tightened-and-relaxed after this run to
  `every(source => !source.pharosDocs)` — "no Pharos documentation reference may be invented" — so
  that a gap reply that *does* cite non-docs URLs (as in README example 4) is still checked
  correctly instead of failing the harness. The behaviour asserted is the same; only the label and
  predicate changed.
- The no-answer run took 13.4 s and exited **2**; the three answerable runs exited **0**.
- The `--timeout 240` argument was passed but never reached: the slowest question took 19.4 s.
- No credential appears in any harness output (`no credential leaked into stdout` passed 4/4), and
  the CLI's own `--json` output was the only thing parsed.

## 6. Secret and sensitive-file scan

```powershell
$ git ls-files | Select-String -Pattern "eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|0x[0-9a-f]{64}|privateKey"
test/fixtures/bootstrap.json:  "accessToken": "eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature"
test/fixtures/session.json:    "accessToken": "eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature"
test/helpers/mock.mjs:29:      export const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature";
test/redact.test.mjs:51:       assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature"));
```

Every match is the **fabricated** fixture token (header `{"alg":"HS256"}`, payload
`fake-payload`, signature `sig-nature`) — it is not a credential and cannot be one. The real
credentials created by `--login` live only in the git-ignored `.local/` directory:

| Path | Content | Tracked? |
| --- | --- | --- |
| `.local/wallet.json` | throwaway EOA private key, created by `--login` | **No** — `.gitignore` covers `.local/` |
| `.local/session.json` | AUTHENTICATED bearer token | **No** — `.gitignore` covers `.local/` |
| `.env` | would hold `PHAROS_ACCESS_TOKEN` | **No** — `.gitignore` covers `.env`; `.env.example` is placeholders only |

A live credential scan of the working tree (excluding `node_modules/`) found matching strings only in
`.local/` (ignored) and in the three fabricated fixture files above. No `.env`, session, wallet,
coverage, build or dependency file is tracked:

```text
$ git status --short --ignored | Select-String ".local|node_modules"
!! .local/
!! node_modules/
```

## 7. What was NOT verified

- **The cited pages were not fetched.** The tool reports reference URLs exactly as the service
  returns them; it does not check that `docs.pharos.xyz` pages exist or that their content matches
  the answer, and it deliberately consults no other documentation source.
- **Answers are non-deterministic.** They come from a hosted LLM agent, so the same question can
  produce different prose (and a different number of references) on another day. The captured
  outputs are dated and the exit-code semantics are what the tests pin down.
- **The Chain MCP was never contacted.** `https://mcp.pharos.xyz/mcp` is out of scope for this tool.
- **No on-chain action of any kind.** No transaction, no `eth_*` call, no balance read; the login
  signature is a message signature only.
- **Quota accounting was not measured.** The guest bootstrap response advertises a guest quota, but
  guest sessions are rejected by the chat endpoint, so only the authenticated path was used and its
  remaining quota was not queried.
- **`npm link` / global install was not exercised.** The CLI was always run as
  `node bin/pharos-docs.mjs`; `bin` is declared in `package.json` so `npx`/`npm link` resolve to the
  same file.
- **No video was created** (not required by the task and explicitly excluded by the brief).

## 8. Repository state at verification time

The live checks in §3–§5 were run against the working tree committed as **`6c7bb3e`** on branch
`main` (36 tracked files, working tree clean). Committer:
`wyka0 <149968432+wyka0@users.noreply.github.com>`. This document was updated afterwards to record the
results, so `git log` on `main` ends with the documentation commit — the code state those results
describe is the one identified above. `.local/` (wallet + session token) and `node_modules/` are
ignored and never committed.
