/**
 * `pharos-docs` — ask the live Pharos Developer Docs MCP a question from the command line.
 *
 * This module holds all CLI behaviour and is fully injectable (`fetch`, `env`, `io`) so the
 * command can be tested end to end offline against mocked responses. `bin/pharos-docs.mjs`
 * is a three-line wrapper that hands it `process.argv`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { AGENT_TYPES, DEFAULT_STREAM_TIMEOUT_MS, PharosDocsClient } from "./mcp.mjs";
import { EXIT, PharosError, exitCodeFor } from "./errors.mjs";
import { NO_ANSWER_MESSAGE, assessAnswer } from "./answer.mjs";
import { formatSourceLines } from "./sources.mjs";
import { redactDeep, redactText } from "./redact.mjs";
import { resolveAuth, resolveStateFile, saveSession } from "./session.mjs";
import { runLogin } from "./login.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @type {string} */
let cachedVersion = "";
function version() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export const HELP = `pharos-docs — ask the Pharos Developer Docs MCP a question

USAGE
  pharos-docs [options] "<question>"
  pharos-docs --login
  pharos-docs --help

The question is sent to the live Pharos Docs MCP agent (ai.pharos.xyz, agentType
PHAROS_DOCS) and the streamed answer is printed together with the source links the
service itself returned. Pharos chain questions (balances, contracts, transactions)
belong to the separate Chain MCP and are out of scope for this tool.

OPTIONS
  -h, --help              Show this help and exit.
  -V, --version           Show the version and exit.
      --login             Sign in with a local throwaway wallet (no funds needed) and
                          cache the session in --state-file. Required once: the Docs MCP
                          refuses anonymous guest sessions.
      --json              Print one machine-readable JSON object instead of prose.
      --debug             Include the redacted raw stream/trace data. Never prints secrets.
      --require-sources   Treat an answer that came back without a source link as "no answer".
      --agent <id>        Agent to ask (default: ${AGENT_TYPES.DOCS}).
      --timeout <sec>     Stream deadline for one answer (default: 300; env PHAROS_STREAM_TIMEOUT_MS).
      --state-file <p>    Cached login session (default: .local/session.json; env PHAROS_STATE_FILE).

ENVIRONMENT
  PHAROS_ACCESS_TOKEN       An AUTHENTICATED bearer token; skips --login (never logged).
  PHAROS_STREAM_TIMEOUT_MS  Stream deadline in milliseconds.
  PHAROS_STATE_FILE         Session cache path.

EXIT CODES
  0  answered (with or without source links — see the note in the output)
  2  no reliable answer found in the available Pharos documentation
  3  operational error (authentication, network, timeout, MCP/protocol failure)
  4  usage error (bad arguments or an empty question)

EXAMPLES
  pharos-docs "How do I deploy a smart contract to Pharos?"
  pharos-docs --json "What is the Atlantic Testnet chain ID and RPC URL?"
  pharos-docs --login
  pharos-docs "What is the capital of France?"
`;

/**
 * @typedef {{
 *   action: "help" | "version" | "login" | "ask",
 *   question: string,
 *   agent: string,
 *   json: boolean,
 *   debug: boolean,
 *   requireSources: boolean,
 *   timeoutMs: number | null,
 *   stateFile: string | null,
 *   walletFile: string | null,
 * }} CliOptions
 */

/**
 * Parse argv strictly. Unknown flags and invalid values are usage errors (exit 4).
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const opts = {
    action: "ask",
    question: "",
    agent: AGENT_TYPES.DOCS,
    json: false,
    debug: false,
    requireSources: false,
    timeoutMs: null,
    stateFile: null,
    walletFile: null,
  };

  /** @type {string[]} */
  const positional = [];
  let login = false;
  let endOfFlags = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (endOfFlags || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];

    /** @param {string} name */
    const value = (name) => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw usageError(`option ${name} requires a value`);
      return next;
    };

    switch (flag) {
      case "-h":
      case "--help":
        opts.action = "help";
        break;
      case "-V":
      case "--version":
        opts.action = "version";
        break;
      case "--login":
        login = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--debug":
        opts.debug = true;
        break;
      case "--require-sources":
        opts.requireSources = true;
        break;
      case "--agent": {
        const value_ = value("--agent");
        const valid = Object.values(AGENT_TYPES);
        if (!valid.includes(value_)) {
          throw usageError(`unknown agent "${value_}"`, `Valid agents: ${valid.join(", ")}`);
        }
        opts.agent = value_;
        break;
      }
      case "--timeout": {
        const raw = value("--timeout");
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw usageError(`--timeout must be a positive number of seconds (got "${raw}")`);
        }
        opts.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--state-file":
        opts.stateFile = value("--state-file");
        break;
      case "--wallet-file":
        opts.walletFile = value("--wallet-file");
        break;
      default:
        throw usageError(`unknown option "${flag}"`);
    }
  }

  opts.question = positional.join(" ").trim();

  if (opts.action === "help" || opts.action === "version") return opts;

  if (login) {
    if (opts.question) throw usageError("--login cannot be combined with a question");
    opts.action = "login";
    return opts;
  }

  if (!positional.length) {
    throw usageError("no question provided", 'Pass a question, e.g. pharos-docs "How do I deploy a contract?"');
  }
  if (!opts.question) {
    throw usageError("the question is empty", "Provide a non-empty question.");
  }
  return opts;
}

/** @param {string} message @param {string|null} [hint] */
function usageError(message, hint = null) {
  return new PharosError(message, { kind: "usage", hint });
}

/** @param {NodeJS.ProcessEnv} env */
function timeoutFromEnv(env) {
  const raw = env.PHAROS_STREAM_TIMEOUT_MS;
  if (!raw) return DEFAULT_STREAM_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_STREAM_TIMEOUT_MS;
}

/** @param {string|null} reason */
export function describeNoAnswerReason(reason) {
  if (!reason) return null;
  if (reason.startsWith("empty-response")) return "the documentation service returned an empty response";
  if (reason.startsWith("timeout-no-content")) return "the request timed out before any answer arrived";
  if (reason.startsWith("insufficient-answer")) return "the documentation service did not return a specific answer";
  if (reason.startsWith("no-sources")) return "the answer contained no source link and --require-sources was set";
  return reason;
}

/**
 * @typedef {{ out: (text: string) => void, err: (text: string) => void }} CliIo
 * @typedef {{ fetch?: typeof fetch, env?: NodeJS.ProcessEnv, io?: CliIo, cwd?: string }} CliDeps
 */

/**
 * Run the CLI. Returns the process exit code; never throws.
 * @param {string[]} argv
 * @param {CliDeps} [deps]
 * @returns {Promise<number>}
 */
export async function runCli(argv, deps = {}) {
  const io = deps.io ?? { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  /** @param {string} text */
  const out = (text) => io.out(`${text}\n`);
  /** @param {string} text */
  const err = (text) => io.err(`${text}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const e = /** @type {PharosError} */ (error);
    err(`error: ${e.message}`);
    if (e.hint) err(`hint: ${e.hint}`);
    err("Run `pharos-docs --help` for usage.");
    return EXIT.USAGE;
  }

  if (opts.action === "help") {
    out(HELP.replace(/\n$/, ""));
    return EXIT.OK;
  }
  if (opts.action === "version") {
    out(`pharos-docs ${version()}`);
    return EXIT.OK;
  }

  const stateFile = opts.stateFile ?? resolveStateFile(env);
  const timeoutMs = opts.timeoutMs ?? timeoutFromEnv(env);
  /** @type {{ kind: string, at: string, detail: Record<string, unknown> }[]} */
  const trace = [];
  const client = new PharosDocsClient({
    fetch: fetchImpl,
    streamTimeoutMs: timeoutMs,
    onTrace: opts.debug ? (entry) => trace.push(entry) : null,
  });

  try {
    if (opts.action === "login") {
      return await doLogin({ client, opts, stateFile, out, err, trace });
    }
    return await doAsk({ client, opts, stateFile, env, out, err, trace, timeoutMs });
  } catch (error) {
    const e = error instanceof PharosError ? error : new PharosError(describeUnexpected(error), { cause: error });
    if (opts.json) {
      out(
        JSON.stringify(
          {
            tool: "pharos-docs",
            version: version(),
            question: opts.question || null,
            status: "error",
            error: { kind: e.kind, message: e.message, hint: e.hint, httpStatus: e.status, code: e.code },
            exitCode: EXIT.OPERATIONAL,
          },
          null,
          2,
        ),
      );
    } else {
      err(`error: ${e.message}`);
      if (e.hint) err(`hint: ${e.hint}`);
    }
    return exitCodeFor(e);
  }
}

function describeUnexpected(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `unexpected failure: ${message}`;
}

/**
 * @param {{
 *   client: PharosDocsClient,
 *   opts: CliOptions,
 *   stateFile: string,
 *   out: (t: string) => void,
 *   err: (t: string) => void,
 *   trace: { kind: string, at: string, detail: Record<string, unknown> }[],
 * }} ctx
 */
async function doLogin(ctx) {
  const { client, opts, stateFile, out, err, trace } = ctx;
  out("Signing in to the Pharos Agent Center with a local throwaway wallet (no funds needed) …");
  const result = await runLogin({
    client,
    walletFile: opts.walletFile ?? undefined,
    onStep: ({ step, detail }) => {
      if (opts.debug && detail) err(`  · ${step} ${JSON.stringify(redactDeep(detail))}`);
    },
  });

  await saveSession(stateFile, {
    accessToken: client.auth?.accessToken ?? "",
    tokenType: client.auth?.tokenType ?? null,
    expiresAt: client.auth?.expiresAt ?? null,
    sessionId: client.auth?.sessionId ?? "",
    address: result.address,
    chainId: result.chainId,
    updatedAt: new Date().toISOString(),
  });

  if (opts.json) {
    out(
      JSON.stringify(
        {
          tool: "pharos-docs",
          version: version(),
          status: "logged-in",
          address: result.address,
          chainId: result.chainId,
          tokenType: result.tokenType,
          expiresAt: result.expiresAt,
          stateFile,
          steps: result.steps,
          exitCode: EXIT.OK,
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  out("Signed in.");
  out(`  address:    ${result.address}`);
  out(`  chainId:    ${result.chainId}`);
  out(`  token type: ${result.tokenType}`);
  out(`  expires at: ${result.expiresAt ?? "(not reported)"}`);
  out(`  session:    cached at ${stateFile} (git-ignored; the token is never printed)`);
  if (opts.debug) out(`  steps:      ${JSON.stringify(redactDeep(result.steps))}`);
  return EXIT.OK;
}

/**
 * @param {{
 *   client: PharosDocsClient,
 *   opts: CliOptions,
 *   stateFile: string,
 *   env: NodeJS.ProcessEnv,
 *   out: (t: string) => void,
 *   err: (t: string) => void,
 *   trace: { kind: string, at: string, detail: Record<string, unknown> }[],
 *   timeoutMs: number,
 * }} ctx
 */
async function doAsk(ctx) {
  const { client, opts, stateFile, env, out, err, trace, timeoutMs } = ctx;

  const auth = await resolveAuth({ env, stateFile });
  if (!auth.token) {
    throw new PharosError("not signed in to the Pharos Docs MCP", {
      kind: "auth",
      hint: "Anonymous guest sessions are refused by the Docs MCP (HTTP 401). Run `pharos-docs --login` once, or set PHAROS_ACCESS_TOKEN.",
    });
  }
  client.setAuth({ accessToken: auth.token, tokenType: auth.tokenType ?? "AUTHENTICATED", expiresAt: auth.expiresAt ?? "" });

  const startedAt = Date.now();
  const reply = await client.ask(opts.question, { agentType: opts.agent });
  const durationMs = Date.now() - startedAt;
  const assessment = assessAnswer(reply, { requireSources: opts.requireSources });
  const ordered = [...assessment.pharosSources, ...assessment.externalSources];

  const exitCode = assessment.status === "ok" ? EXIT.OK : assessment.status === "no-answer" ? EXIT.NO_ANSWER : EXIT.OPERATIONAL;

  if (opts.json) {
    out(
      JSON.stringify(
        {
          tool: "pharos-docs",
          version: version(),
          question: opts.question,
          status: assessment.status,
          reason: assessment.reason,
          message: assessment.message,
          hint: assessment.hint,
          answer: assessment.answer,
          sources: ordered,
          sourceCount: ordered.length,
          warnings: assessment.warnings,
          agent: reply.agentType,
          finished: reply.finished,
          timedOut: reply.timedOut,
          interrupted: reply.interrupted,
          auth: { source: auth.source, tokenType: auth.tokenType, expiresAt: auth.expiresAt ?? null },
          durationMs,
          exitCode,
          ...(opts.debug
            ? {
                debug: redactDeep({
                  frames: reply.frames,
                  stats: reply.stats,
                  errors: reply.errors,
                  cards: reply.cards,
                  trace,
                }),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    return exitCode;
  }

  out(`Question: ${opts.question}`);
  out("");

  if (assessment.status === "ok") {
    out(assessment.answer);
    out("");
    if (ordered.length) {
      out(`Sources the Docs MCP returned (${ordered.length}) — every URL below is exactly as the service returned it:`);
      if (assessment.pharosSources.length) {
        out(`  docs.pharos.xyz (${assessment.pharosSources.length}):`);
        for (const line of formatSourceLines(assessment.pharosSources, "    ")) out(line);
      }
      if (assessment.externalSources.length) {
        out(`  other hosts mentioned in the answer (${assessment.externalSources.length}):`);
        for (const line of formatSourceLines(assessment.externalSources, "    ")) out(line);
      }
    } else {
      out("Sources: none.");
    }
    for (const warning of assessment.warnings) out(`note: ${warning}`);
    if (opts.debug) printDebug(err, reply, trace, timeoutMs);
    return exitCode;
  }

  if (assessment.status === "no-answer") {
    out(NO_ANSWER_MESSAGE);
    const reason = describeNoAnswerReason(assessment.reason);
    if (reason) err(`detail: ${reason}`);
    if (opts.debug) printDebug(err, reply, trace, timeoutMs);
    return exitCode;
  }

  // status === "error" — the service reported a stream error, a timeout, or an interrupted stream.
  err(`error: ${assessment.message}`);
  err(`hint: ${assessment.hint ?? "Retry in a moment; if it persists the documentation service may be degraded."}`);
  if (opts.debug) {
    if (assessment.answer) err(`partial output kept (${assessment.answer.length} chars) — see --json for the text`);
    printDebug(err, reply, trace, timeoutMs);
  }
  return exitCode;
}

/**
 * `--debug` output: redacted raw frames, stream stats and the trace. Never contains secrets.
 */
function printDebug(err, reply, trace, timeoutMs) {
  err("");
  err("--- debug (secrets redacted) ---");
  err(`timeoutMs: ${timeoutMs}`);
  err(
    `stream: finished=${reply.finished} timedOut=${reply.timedOut} interrupted=${reply.interrupted} ` +
      `dataFrames=${reply.stats?.dataFrames ?? 0} malformedFrames=${reply.stats?.malformedFrames ?? 0}`,
  );
  err(`stream errors: ${JSON.stringify(redactDeep(reply.errors))}`);
  if (reply.frames?.length) {
    err(`raw frames (${reply.frames.length}):`);
    for (const frame of reply.frames.slice(0, 60)) err(`  ${redactText(frame)}`);
    if (reply.frames.length > 60) err(`  … ${reply.frames.length - 60} more frame(s) suppressed`);
  }
  if (trace?.length) {
    err(`trace (${trace.length}):`);
    for (const entry of trace) err(`  ${entry.at} ${entry.kind} ${JSON.stringify(redactDeep(entry.detail))}`);
  }
  err("--- end debug ---");
}

export default runCli;
