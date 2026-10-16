#!/usr/bin/env node
/**
 * OPTIONAL live smoke test — the only part of this repository that talks to the real service.
 *
 * It is deliberately NOT part of `npm test`, so the standard suite never depends on the
 * availability of ai.pharos.xyz. Run it explicitly:
 *
 *   node scripts/live-smoke.mjs                     # uses .local/session.json / PHAROS_ACCESS_TOKEN
 *   node scripts/live-smoke.mjs --login             # sign in first, then run the questions
 *   node scripts/live-smoke.mjs --timeout 120       # per-question stream deadline (seconds)
 *
 * It asks one question that the documentation supports and one that it should not be able to
 * answer, and asserts the CLI's contract on each (exit code, answer present, sources preserved,
 * no secrets in the output). It prints exactly what it observed; nothing is fabricated.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readFileSync } from "node:fs";
import { ASSERT_QUESTIONS, NO_GOOD_ANSWER_QUESTION } from "./live-questions.mjs";
import { redactText } from "../src/redact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "pharos-docs.mjs");

function parseArgs(argv) {
  const out = { login: false, timeout: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--login") out.login = true;
    else if (argv[i] === "--timeout") out.timeout = argv[++i];
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** @param {string[]} cliArgs */
function run(cliArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...cliArgs], { cwd: ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** @param {string} label @param {boolean} ok @param {string} detail */
function report(label, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  process.stdout.write(`${status.padEnd(5)} ${label}\n`);
  if (detail) process.stdout.write(`      ${redactText(detail).split("\n").join("\n      ")}\n`);
  return ok;
}

let failures = 0;
const results = [];

if (args.login) {
  process.stdout.write("Running `pharos-docs --login` (wallet signature only, no funds move) …\n");
  const login = await run(["--login"]);
  failures += report("login: exit 0", login.code === 0, login.stdout.trim().split("\n").slice(0, 6).join("\n")) ? 0 : 1;
  if (login.code !== 0) process.stdout.write(redactText(login.stderr));
}

let version = "unknown";
try {
  version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
} catch {
  /* ignore */
}

const timeoutArgs = args.timeout ? ["--timeout", args.timeout] : [];

for (const question of [...ASSERT_QUESTIONS, NO_GOOD_ANSWER_QUESTION]) {
  const cliArgs = ["--json", ...timeoutArgs, question];
  const started = Date.now();
  const { code, stdout, stderr } = await run(cliArgs);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    failures += report(`[${question}] returned parseable JSON`, false, stdout.slice(0, 400) || stderr.slice(0, 400)) ? 0 : 1;
    continue;
  }

  const isNoAnswerCase = question === NO_GOOD_ANSWER_QUESTION;
  const expected = isNoAnswerCase ? 2 : 0;
  let ok = true;
  ok = report(`[${question}] exit code ${expected} (got ${code}, ${seconds}s)`, code === expected, stderr.trim()) && ok;

  if (isNoAnswerCase) {
    ok = report("  no-answer status", payload.status === "no-answer", payload.message ?? "") && ok;
    ok =
      report(
        "  no Pharos documentation reference invented",
        Array.isArray(payload.sources) && payload.sources.every((s) => !s.pharosDocs),
        JSON.stringify(payload.sources),
      ) && ok;
  } else {
    ok = report(`  answer present (${payload.answer?.length ?? 0} chars)`, typeof payload.answer === "string" && payload.answer.length > 0, payload.answer?.slice(0, 200) ?? "") && ok;
    ok = report(`  source links preserved (${payload.sourceCount ?? 0})`, Array.isArray(payload.sources) && payload.sources.length >= 1, (payload.sources ?? []).map((s) => s.url).join("\n")) && ok;
    const pharos = (payload.sources ?? []).filter((s) => s.pharosDocs).length;
    ok = report(`  at least one docs.pharos.xyz reference (${pharos})`, pharos >= 1, "") && ok;
  }
  ok = report("  no credential leaked into stdout", !/eyJ[A-Za-z0-9_-]{5,}\./.test(stdout), "") && ok;
  failures += ok ? 0 : 1;
  results.push({ question, code, seconds: Number(seconds), status: payload.status, sourceCount: payload.sourceCount ?? 0 });
}

process.stdout.write(`\npharos-docs ${version} — live smoke summary\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nALL LIVE CHECKS PASSED\n" : `\n${failures} LIVE CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
