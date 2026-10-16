# pharos-docs

A command-line tool that answers **Pharos developer questions** using the live **Pharos Developer
Docs MCP** at [ai.pharos.xyz](https://ai.pharos.xyz), and prints the **source documentation links
the service itself returned** — never a link it invented.

```text
$ pharos-docs "What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used."
```

- **One question in, one answer out**, with the documentation references the service returned.
- **Honest failure**: if the documentation does not support an answer, the CLI says so and exits
  with a distinct code instead of guessing.
- **Scriptable**: `--json` output and distinct exit codes (0 / 2 / 3 / 4).
- **No secrets in output**: bearer tokens, session ids and key material are redacted by design,
  including in `--debug` mode.

> **Not the Chain MCP.** This tool queries the *documentation* agent (`PHAROS_DOCS`). It does not
> query the Pharos **Chain MCP** (`https://mcp.pharos.xyz/mcp`), so questions about balances,
> contracts or transactions are out of scope. It also never uses a search engine or any other
> documentation source.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Authentication](#authentication-one-time)
- [Usage](#usage)
- [Exit codes](#exit-codes)
- [How answers and sources are produced](#how-answers-and-sources-are-produced)
- [Answer-quality policy](#answer-quality-policy)
- [Example queries (captured live)](#example-queries-captured-live)
- [JSON output](#json-output)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [License](#license)

---

## Requirements

| Requirement | Detail |
| --- | --- |
| Node.js | **20 or newer** (uses the built-in test runner, `fetch`, `AbortController`, ESM) |
| Network | HTTPS access to `flow.anvita.xyz` (the Agent Center API used by ai.pharos.xyz) |
| Wallet | **Not required to hold funds.** Sign-in uses `personal_sign` only — never a transaction |
| OS | Developed and verified on Windows 11 / Node 24; no platform-specific code |

## Install

```powershell
git clone https://github.com/wyka0/pharos-doc-search-cli.git
cd pharos-doc-search-cli
npm ci                 # installs the single runtime dependency (viem), from the lockfile
node bin/pharos-docs.mjs --help
```

Optionally put `pharos-docs` on your `PATH`:

```powershell
npm link               # then use:  pharos-docs "how do I deploy a contract?"
```

All commands below are shown as `pharos-docs …`; `node bin/pharos-docs.mjs …` is exactly
equivalent if you skip `npm link`.

## Authentication (one time)

The Pharos Docs MCP **refuses anonymous guest sessions** — a guest token is rejected by the chat
endpoint with `HTTP 401 {"code":"401","message":"Unauthorized, please login first"}`. Sign in once:

```powershell
pharos-docs --login
```

This performs the same handshake as the web app:

1. `POST /api/v1/widget/bootstrap` — anonymous guest session,
2. `POST /api/v1/widget/wallet/challenge` → `POST /api/v1/widget/agentcenter/wallet/verify` —
   sign-in with an EIP-191 signature,
3. `GET /api/v1/widget/onboarding/status` (+ guardian EIP-712 claim on a brand-new account),
4. `POST /api/v1/widget/agentcenter/onboarding/complete` — token upgraded to `AUTHENTICATED`.

The signing identity is a **throwaway EOA generated locally** and stored in
`.local/wallet.json` (git-ignored, permissions restricted where the OS supports it). It is used
only for `personal_sign` / `signTypedData`; it holds no funds and needs none. The private key is
never printed. The resulting bearer token is cached in `.local/session.json` (also git-ignored)
and is never printed either.

For CI or other environments, skip `--login` and provide a token instead:

```powershell
$env:PHAROS_ACCESS_TOKEN = "<AUTHENTICATED bearer token>"   # never logged; redacted in --debug
pharos-docs "how do I deploy a contract?"
```

## Usage

```text
pharos-docs [options] "<question>"
pharos-docs --login
pharos-docs --help
```

| Option | Meaning |
| --- | --- |
| `-h`, `--help` | Print help and exit 0 |
| `-V`, `--version` | Print the version and exit 0 |
| `--login` | Sign in with a local throwaway wallet and cache the session |
| `--json` | Emit one machine-readable JSON object instead of prose |
| `--debug` | Add redacted raw SSE frames, stream statistics and a request trace (stderr) |
| `--require-sources` | Treat an answer with no source link as *no answer* (exit 2) — for strict pipelines |
| `--agent <id>` | Agent to ask (default `PHAROS_DOCS`). The other ids on the same surface — `PHAROS_PERSONAL_AGENT`, `PHAROS_SKILL_ENGINE`, `PHAROS_MCP` — are accepted but out of scope for this tool and not verified here |
| `--timeout <seconds>` | Stream deadline for one answer (default 300) |
| `--state-file <path>` | Cached session location (default `.local/session.json`) |

Environment variables (see [`.env.example`](.env.example)): `PHAROS_ACCESS_TOKEN`,
`PHAROS_STREAM_TIMEOUT_MS`, `PHAROS_STATE_FILE`.

Several unquoted words are joined into one question, so `pharos-docs how do I deploy` works — but
quoting is recommended so your shell does not interpret punctuation.

### Exit codes

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `0` | An answer was produced | The service answered (with or without source links — see the note in the output) |
| `2` | **No reliable answer found** | The service returned no usable answer, or the answer was insufficient, or `--require-sources` was set and no link came back |
| `3` | **Operational error** | Not signed in / session refused (401/403), network failure, client timeout with no answer, HTTP 5xx, malformed control response, service error frame |
| `4` | **Usage error** | Missing/empty question, unknown option, invalid `--timeout`/`--agent` |

```powershell
pharos-docs "what is the Pharos faucet URL?" ; if ($LASTEXITCODE -eq 2) { "not documented" }
```

## How answers and sources are produced

Both endpoints were verified live; nothing else is called.

```text
POST https://flow.anvita.xyz/api/v1/widget/bootstrap            (guest session, and the --login legs)
POST https://flow.anvita.xyz/api/v1/pharos/chat/completions      (the Docs MCP query path, SSE)
     body: { spaceType:"pharos", operationType:"chat", agentType:"PHAROS_DOCS",
             sessionId:<chat session id>, message, requestId, stream:true }
```

The answer arrives as a `text/event-stream` of `data: {...}` frames terminated by `data: [DONE]`,
and is assembled from the `choices[].delta.content` chunks (`reasoning_content` is ignored for the
answer and available only via `--debug`).

**Source-reference format.** The service does **not** return a citations array, document ids or a
search-result envelope (the `card` channel was empty in every observed reply). Its references are
**inline Markdown links inside the answer text**, e.g.

```markdown
**Source:** [Pacific Mainnet — Pharos Docs](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)
```

The CLI extracts those links (and bare URLs outside code fences) and prints them **byte for byte**
in the order they appear, grouping `docs.pharos.xyz` links first:

```text
Sources the Docs MCP returned (2) — every URL below is exactly as the service returned it:
  docs.pharos.xyz (1):
    1. Pacific Mainnet — Pharos Docs — https://docs.pharos.xyz/getting-started/network/pacific-mainnet
  other hosts mentioned in the answer (1):
    1. rpc.pharos.xyz — https://rpc.pharos.xyz
```

The grouping is a presentation aid only: a URL under *other hosts* is still exactly what the service
wrote (for example an RPC endpoint quoted in a parameter table) and is **not** presented as a
documentation page. If the service returns an answer with no links, the CLI says
`Sources: none.` plus
`No source link was returned by the documentation service for this answer, so no reference can be shown.`
— it does not fabricate one.

## Answer-quality policy

Decisions are made **only** from text the service returned. The CLI adds no facts of its own.

| # | Condition | Result | Exit |
| --- | --- | --- | --- |
| 1 | The stream contains an error frame | Operational error, naming the service error (`--json`/`--debug` keep any partial text) | 3 |
| 2 | Response text is empty and the deadline hit | Operational error: *did not start answering before the stream deadline* | 3 |
| 3 | Response text is empty and the stream was cut off | Operational error: *stream ended before any answer arrived* | 3 |
| 4 | Response text is empty otherwise | No answer: `No reliable answer found in the available Pharos documentation. Try a more specific question.` | 2 |
| 5 | The text is a first-person inability / "no information" phrasing (`I don't have enough information`, `couldn't find`, `the documentation does not cover …`, …) | No answer (same message) | 2 |
| 6 | The service states that the documentation does not cover the question **and** returned no `docs.pharos.xyz` reference | No answer (same message); the service's wording stays visible via `--json`/`--debug` | 2 |
| 7 | `--require-sources` set and the answer contains no link | No answer (same message) | 2 |
| 8 | Otherwise | The answer, its source links, and a note if the answer was partial | 0 |

A partial answer (the client deadline hit *after* text started arriving) is printed **with** a
warning note rather than being thrown away, because the hosted agent legitimately takes 30–150 s per
question. An answer whose stream never sent `data: [DONE]` is printed with an "ended unexpectedly"
note.

**Why rule 6 is narrow.** A documentation-gap statement only becomes a no-answer when the service
also returned no `docs.pharos.xyz` reference. An answer that reports a gap *and* cites the pages it
summarised is a real answer — this is exactly what the live faucet question does (it reports that the
docs mention a faucet but publish no URL, while citing four Pharos documentation pages), and it exits
0. Both cases are covered by tests and by live runs (see
[`docs/verified-output.md`](docs/verified-output.md) §4.1).

**Deliberate non-goals.** The policy does not try to fact-check the service. A confident, wrong
answer is out of scope: this tool reports what the documentation service said, with the references it
gave. The one live case where a nonsensical question produced an off-topic answer with **no**
references is documented in [`docs/verified-output.md`](docs/verified-output.md) §4.2 — that is the
behaviour rule 7 (`--require-sources`) exists for.

## Example queries (captured live)

All examples below were run against the **live** Docs MCP on **2026-10-16** from this repository with
`node bin/pharos-docs.mjs` (Windows 11, Node v24.14.1). Outputs are quoted **exactly as printed** —
including the service's own typos, tables and URL formatting. Answers come from a hosted agent, so
re-running a question can produce different prose; the exit-code semantics do not change. Timings are
the `--timeout 240` runs recorded in [`docs/verified-output.md`](docs/verified-output.md).

| # | Question (short) | Exit | References returned | Time |
| --- | --- | --- | --- | --- |
| 1 | Pacific Mainnet RPC + chain ID | 0 | 3 (1 × docs.pharos.xyz) | 12.7 s |
| 2 | Deploy a contract with Hardhat | 0 | 5 (2 × docs.pharos.xyz) | 83.8 s |
| 3 | Test network + faucet situation | 0 | 7 (4 × docs.pharos.xyz) | 99.5 s |
| 4 | PROS market price "according to the docs" | 2 | 0 docs pages — an honest no-answer | 18.0 s |

### 1. A documentation question with a page reference

```powershell
node bin/pharos-docs.mjs --timeout 240 "What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used."
```

**Sufficient — exit 0, 12.7 s.** The service returned the parameters *and* cited the page it used.

```text
Question: What are the RPC URL and chain ID of Pharos Pacific Mainnet? Cite the documentation page you used.

**Pharos Pacific Mainnet**

| Parameter | Value |
|---|---|
| **RPC URL** | `https://rpc.pharos.xyz` |
| **Chain ID** | `1672` |
| Native token | PROS |
| Block Explorer | `https://www.pharosscan.xyz` |

**Source:** [Pacific Mainnet — Pharos Docs](https://docs.pharos.xyz/getting-started/network/pacific-mainnet)

Sources the Docs MCP returned (3) — every URL below is exactly as the service returned it:
  docs.pharos.xyz (1):
    1. Pacific Mainnet — Pharos Docs — https://docs.pharos.xyz/getting-started/network/pacific-mainnet
  other hosts mentioned in the answer (2):
    1. rpc.pharos.xyz — https://rpc.pharos.xyz
    2. www.pharosscan.xyz — https://www.pharosscan.xyz
```

**Why it counts as sufficient:** the answer is specific, and one of the returned references is a
`docs.pharos.xyz` page. The two extra URLs under *other hosts* are the RPC endpoint and the explorer
that the service quoted inside its own parameter table — reported verbatim, not as documentation pages.

### 2. A procedural question (commands + page)

```powershell
node bin/pharos-docs.mjs --timeout 240 "How do I deploy a smart contract to Pharos with Hardhat? Give the exact commands and the documentation page."
```

**Sufficient — exit 0, 83.8 s.** Note that referenced URLs inside the fenced `shell` examples
(`github.com/PharosNetwork/examples`) are *not* listed as sources: the tool only treats inline links
and bare URLs in prose as references.

```text
Question: How do I deploy a smart contract to Pharos with Hardhat? Give the exact commands and the documentation page.

Here's how to deploy a smart contract to Pharos with Hardhat, following the official docs:

---

### Prerequisites
- **Git**
- **Node.js** (from [nodejs.org](https://nodejs.org/))
- **Hardhat** installed ([installation guide](https://hardhat.org/hardhat-runner/docs/getting-started#installation))
- Access to a Pharos network (testnet or mainnet)

---

### Step 1 — Clone the example project

```shell
git clone https://github.com/PharosNetwork/examples
cd examples/dapp/hardhat
npm install
```

### Step 2 — Set your private key

Hardhat's variable manager stores the deployer key securely:

```shell
npx hardhat vars set PRIVATE_KEY
```

You'll be prompted to paste the private key (without the `0x` prefix is fine — Hardhat handles both).

### Step 3 — Install contract dependencies and deploy

```shell
cd contract && npm install
npx hardhat ignition deploy ./ignition/modules/Counter.js --network pharos
```

The `--network pharos` flag uses the `pharos` network entry already configured in the example repo's `hardhat.config.js`. Ignition will compile the contract, estimate gas, broadcast the deployment transaction, and print the new contract address on success.

---

### Variations for other contract types

The same pattern applies to the other Hardhat example guides — only the Ignition module path changes:

| Contract type | Deploy command |
|---|---|
| Counter (dApp) | `npx hardhat ignition deploy ./ignition/modules/Counter.js --network pharos` |
| ERC-20 Token | `npx hardhat ignition deploy ./ignition/modules/Token.js --network pharos` |
| NFT | `npx hardhat ignition deploy ./ignition/modules/Token.js --network pharos` |
| Uniswap-style | `npx hardhat ignition deploy ./ignition/modules/Token.js --network pharos` |

---

### Troubleshooting
- **Deployment fails** — Make sure the deployer wallet has enough PROS (or testnet tokens) to cover gas.
- **Wrong network** — Verify the `pharos` network in `hardhat.config.js` points at the RPC URL and chain ID you intend to target (e.g., Pacific Mainnet: `https://rpc.pharos.xyz`, chain ID `1672`).

---

### Documentation page

**[Write Your First dApp — Pharos Docs](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)** (retrieved via the Pharos GitBook MCP server at `https://docs.pharos.xyz/~gitbook/mcp`).

Sources the Docs MCP returned (5) — every URL below is exactly as the service returned it:
  docs.pharos.xyz (2):
    1. Write Your First dApp — Pharos Docs — https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp
    2. docs.pharos.xyz — https://docs.pharos.xyz/~gitbook/mcp
  other hosts mentioned in the answer (3):
    1. nodejs.org — https://nodejs.org/
    2. installation guide — https://hardhat.org/hardhat-runner/docs/getting-started#installation
    3. rpc.pharos.xyz — https://rpc.pharos.xyz
```

**Why it counts as sufficient:** it answers the question with concrete commands and links the
`docs.pharos.xyz` page it used. Two of the returned URLs are the service's own tooling endpoint
(`~gitbook/mcp`) and generic toolchain sites — the CLI lists them under the host they came from and
does not present them as Pharos documentation pages.

### 3. A question whose answer includes a documented gap

```powershell
node bin/pharos-docs.mjs --timeout 240 "Which network should a developer use for testing on Pharos, and what is its faucet situation according to the documentation?"
```

**Sufficient — exit 0, 99.5 s.** This is the interesting case for the answer-quality policy: the
service reports that the faucet is *mentioned but not specified* in the docs **and** cites the pages
it summarised, so the CLI reports it as an answer (with 4 `docs.pharos.xyz` references) rather than a
no-answer.

```text
Question: Which network should a developer use for testing on Pharos, and what is its faucet situation according to the documentation?

## Test Network: Atlantic Testnet

Developers should use **Atlantic Testnet** for testing on Pharos.

| Parameter | Value |
|---|---|
| **Network** | Atlantic Testnet |
| **Chain ID** | `688689` |
| **RPC (HTTPS)** | `https://atlantic.dplabs-internal.com` |
| **WSS** | `wss://atlantic.dplabs-internal.com` |
| **Block Explorer** | `https://atlantic.pharosscan.xyz/` |
| **Rate limit** | 500 requests / 5 min |
| **Max pending TXs per address** | 64 |

---

## Faucet Situation

The documentation's faucet guidance is limited:

- The **Piggy Bank Tutorial** mentions using the "Pharos faucet" **or getting funds directly from the team** to obtain testnet PHRS, but it does **not** include a public faucet URL or self-service claim steps.
- The **"Get PROS Gas"** page covers **mainnet** PROS acquisition only (via Halliday, Alchemy Pay, or TopNod at [port.pharos.xyz/get-pros](https://port.pharos.xyz/get-pros)) — it is not a testnet faucet.

**Bottom line:** The docs reference a Pharos faucet but don't publish a self-service URL. The documented fallback for getting testnet funds is to **contact the Pharos team directly**.

---

### Documentation pages used

1. **[Atlantic Testnet](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)** — network parameters
2. **[Get PROS Gas](https://docs.pharos.xyz/getting-started/get-pros-gas)** — mainnet PROS acquisition (not a testnet faucet)
3. **[Piggy Bank Tutorial](https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide)** — mentions the faucet and "get funds from the team" alternative

All retrieved via the Pharos GitBook MCP server at `https://docs.pharos.xyz/~gitbook/mcp`.

Sources the Docs MCP returned (7) — every URL below is exactly as the service returned it:
  docs.pharos.xyz (4):
    1. Atlantic Testnet — https://docs.pharos.xyz/getting-started/network/atlantic-testnet
    2. Get PROS Gas — https://docs.pharos.xyz/getting-started/get-pros-gas
    3. Piggy Bank Tutorial — https://docs.pharos.xyz/tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide
    4. docs.pharos.xyz — https://docs.pharos.xyz/~gitbook/mcp
  other hosts mentioned in the answer (3):
    1. port.pharos.xyz/get-pros — https://port.pharos.xyz/get-pros
    2. atlantic.dplabs-internal.com — https://atlantic.dplabs-internal.com
    3. atlantic.pharosscan.xyz — https://atlantic.pharosscan.xyz/
```

**Why it counts as sufficient:** the question is answered (the test network and its parameters) and
the documentation gap is stated with the pages that were consulted. A gap statement only becomes a
*no-answer* when the service also cites no `docs.pharos.xyz` page — see example 4.

### 4. A question the documentation cannot answer (the no-answer path)

```powershell
node bin/pharos-docs.mjs --timeout 240 "According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?"
```

**Insufficient — `exit 2`, 15.0 s.** The service answered with a *documentation-gap statement* and
cited **no** `docs.pharos.xyz` page, so the CLI reports "no reliable answer" instead of dressing the
gap up as documentation:

```text
Question: According to the Pharos developer documentation, what was the exact USD closing price of PROS on Binance yesterday?

No reliable answer found in the available Pharos documentation. Try a more specific question.
```

```text
stderr:
detail: documentation-does-not-cover
```

**Why this is the correct call:** the service's own reply was

> The Pharos developer documentation does not contain cryptocurrency price data, including PROS
> trading prices on Binance or any other exchange. […] For PROS price information, you would need to
> check: [Binance](https://www.binance.com) directly […]

That is a statement about the *absence* of documentation, and its only links are
`https://www.binance.com` and `https://www.pharosscan.xyz` — neither is a Pharos documentation page.
The CLI therefore exits 2, prints the required no-answer message, and **keeps the service's wording
available** (from the same live run, `--json` form, abridged):

```json
{
  "status": "no-answer",
  "reason": "documentation-does-not-cover",
  "message": "No reliable answer found in the available Pharos documentation. Try a more specific question.",
  "answer": "The Pharos developer documentation does not contain cryptocurrency price data, including PROS trading prices on Binance or any other exchange. …",
  "sources": [
    { "title": "Binance", "url": "https://www.binance.com", "host": "www.binance.com", "pharosDocs": false },
    { "title": "pharosscan.xyz", "url": "https://www.pharosscan.xyz", "host": "www.pharosscan.xyz", "pharosDocs": false }
  ],
  "sourceCount": 2,
  "warnings": [],
  "exitCode": 2
}
```

(the `sources` array above is exactly what that run reported in text mode as
`other hosts mentioned in the answer (2)`; the object itself is abridged — omitted keys are
`tool`, `version`, `question`, `hint`, `agent`, `finished`, `timedOut`, `interrupted`, `auth` and
`durationMs`.)

Nothing in that object is invented: `sources` holds exactly the two URLs the service wrote, and the
`answer` field is its verbatim text. (The block is the `--json` *shape* of the same run — rendered
here abridged with the `answer` field truncated; every value in it was produced by that run and its
text-mode stdout is quoted byte-for-byte above.) A script that only wants well-sourced documentation
answers should add `--require-sources`, which makes *any* answer without a link exit 2 as well.



## JSON output

`--json` prints exactly one object on stdout (nothing else), so it can be piped straight into `jq`
or another program. The shape, **abbreviated and illustrative**:

```json
{
  "tool": "pharos-docs",
  "version": "1.0.0",
  "question": "What are the RPC URL and chain ID of Pharos Pacific Mainnet?",
  "status": "ok",
  "reason": null,
  "message": null,
  "hint": null,
  "answer": "**Pharos Pacific Mainnet** … `https://rpc.pharos.xyz` … `1672` …",
  "sources": [
    { "title": "Pacific Mainnet — Pharos Docs", "url": "https://docs.pharos.xyz/getting-started/network/pacific-mainnet", "host": "docs.pharos.xyz", "pharosDocs": true }
  ],
  "sourceCount": 1,
  "warnings": [],
  "agent": "PHAROS_DOCS",
  "finished": true,
  "timedOut": false,
  "interrupted": false,
  "auth": { "source": "file", "tokenType": "AUTHENTICATED", "expiresAt": "2026-10-17T17:45:38Z" },
  "durationMs": 31250,
  "exitCode": 0
}
```

- `status` is `ok` | `no-answer` | `error`; operational failures are reported as
  `{"status":"error","error":{"kind":…,"message":…,"hint":…},"exitCode":3}`.
- `auth` reports only the token **type**, its expiry and whether it came from `env` or the cached
  `file` — never the token.
- With `--debug`, a redacted `debug` object is added: raw frames, stream statistics, card payloads
  and the request trace. Tokens, bearer headers, UUIDs and 32-byte hex values are replaced with
  `<redacted…>` placeholders.

## Tests

```powershell
npm ci          # from package-lock.json
npm run check   # syntax check of every module (Node's parser; no third-party linter)
npm test        # 86 deterministic tests, no network and no wallet required
npm run verify  # check + test
npm run smoke   # OPTIONAL live smoke test against the real Docs MCP (not part of npm test)
```

`npm test` uses Node's built-in test runner and **mocked HTTP only** — every fixture under
`test/fixtures/` is fabricated. It covers: SSE chunking/CRLF/comment/malformed frames, `[DONE]` and
interrupted streams, deadline behaviour, source extraction and preservation, the whole
answer-quality decision table, the auth/network/timeout/HTTP/stream error paths, secret redaction,
session caching, `--login`, argument validation, exit codes in-process and as a child process.

`npm run smoke` is the only test that talks to the real service. It requires a signed-in session
(`pharos-docs --login` first) and asks three answerable questions plus one that the documentation
cannot answer, asserting for each: the exit code (0 / 2), that an answer was present, that the source
links were preserved, that at least one `docs.pharos.xyz` reference came back for the answerable
ones, and that the no-answer run **invented no Pharos documentation reference**. The standard suite
never depends on service availability. See [`docs/verified-output.md`](docs/verified-output.md) for
the recorded live results.

## Project layout

```text
bin/pharos-docs.mjs      executable entry point (forwards argv, sets the exit code)
src/cli.mjs              argument parsing, output modes, the doAsk/doLogin flows
src/mcp.mjs              Docs MCP client: bootstrap, chat/SSE, onboarding, error mapping
src/sse.mjs              dependency-free SSE decoder + reply assembly
src/answer.mjs           answer-quality policy (ok / no-answer / error)
src/sources.mjs          source-reference extraction (no rewriting, no invention)
src/session.mjs          cached-session read/write and auth resolution
src/login.mjs            wallet sign-in + onboarding handshake
src/errors.mjs           error taxonomy and exit codes
src/redact.mjs           redaction of tokens, ids and key material
scripts/check-syntax.mjs static syntax check used by `npm run check`
scripts/live-smoke.mjs   optional live smoke test
scripts/live-questions.mjs the questions used by the live smoke test
test/                    86 mocked tests + fabricated fixtures
docs/verified-output.md  exactly what was run, and what it printed
```

## Security and privacy

- No secret is ever printed: bearer tokens, `Authorization` values, session/request UUIDs and
  32-byte hex values are redacted in **all** output, including `--debug` and `--json --debug`.
- The login wallet key and the session token live only in `.local/` (git-ignored); nothing in this
  repository contains credentials, session files or local authentication state.
- `--login` never signs a transaction and moves no funds; only `personal_sign` /
  `signTypedData` message signatures are produced.
- The only network destinations are the two `flow.anvita.xyz` endpoints documented above.
- The optional live smoke test and the real CLI never print the question's raw SSE frames unless
  `--debug` is passed, and even then they are redacted.

## Limitations

- **The Docs MCP is a hosted LLM agent, not a search index.** Answers are synthesised prose. The
  CLI preserves the references the agent chose to include; it cannot make the agent cite a page,
  and it does not verify the pages exist.
- **No citations API.** If the answer text contains no Markdown link, there is no source reference
  to show. Use `--require-sources` to make that a hard failure.
- **Latency is 30–150 s per question** (observed). The default deadline is 300 s; a partial answer
  is returned with a warning rather than discarded.
- **Quota is account-bound.** The service rate-limits or rejects sessions (HTTP 401/403/429); the
  CLI reports those as exit 3 with a hint. Anonymous guest sessions are not usable at all.
- **One question per invocation.** Conversation context accumulates inside the service session, so
  later answers can be influenced by earlier ones; keep questions self-contained.
- **The Chain MCP is out of scope.** On-chain data questions belong to `https://mcp.pharos.xyz/mcp`.
- **No offline mode.** Every answer requires the live service.
- The service sometimes cites its own internal GitBook endpoint (`https://docs.pharos.xyz/~gitbook/mcp`).
  The CLI reproduces it verbatim when the service returns it; it is not a documentation page.

## License

[MIT](LICENSE) © 2026 wyka0
