/**
 * Process-level CLI tests: run the real `bin/pharos-docs.mjs` in a child process.
 *
 * These cover the pieces that only exist at the process boundary (argv forwarding, exit
 * codes, stdout/stderr separation). They use no network and no credentials — every case
 * here is a usage path that must not reach the service.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pharos-docs.mjs");

/** @param {string[]} args */
function runBin(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, PHAROS_STATE_FILE: "does-not-exist.json" } });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

test("bin: --help prints usage on stdout and exits 0", () => {
  const { code, out, err } = runBin(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /USAGE/);
  assert.match(out, /pharos-docs \[options\] "<question>"/);
  assert.equal(err, "");
});

test("bin: --version exits 0", () => {
  const { code, out } = runBin(["--version"]);
  assert.equal(code, 0);
  assert.match(out.trim(), /^pharos-docs \d+\.\d+\.\d+$/);
});

test("bin: no arguments is a usage error on stderr with exit code 4", () => {
  const { code, out, err } = runBin([]);
  assert.equal(code, 4);
  assert.match(err, /no question provided/);
  assert.equal(out, "");
});

test("bin: an unknown option exits 4 without touching the network", () => {
  const { code, err } = runBin(["--frobnicate", "hello"]);
  assert.equal(code, 4);
  assert.match(err, /unknown option/);
});

test("bin: an empty question exits 4", () => {
  const { code, err } = runBin(["   "]);
  assert.equal(code, 4);
  assert.match(err, /empty/);
});

test("bin: asking a question with no session exits 3 and points at --login", () => {
  const { code, err } = runBin(["How do I deploy a contract?"]);
  assert.equal(code, 3);
  assert.match(err, /not signed in/);
  assert.match(err, /--login/);
});

test("bin: --json on a missing session still returns one JSON object", () => {
  const { code, out } = runBin(["--json", "How do I deploy a contract?"]);
  assert.equal(code, 3);
  const payload = JSON.parse(out);
  assert.equal(payload.status, "error");
  assert.equal(payload.error.kind, "auth");
  assert.equal(payload.exitCode, 3);
});
