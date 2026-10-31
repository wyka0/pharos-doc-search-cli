#!/usr/bin/env node
/**
 * Pharos RPC deprecation guard.
 *
 * The official Pharos notice disables these JSON-RPC trace methods on the
 * public RPC endpoints (https://rpc.pharos.xyz and
 * https://testnet.dplabs-internal.com):
 *
 *   debug_traceTransaction, debug_traceBlockByNumber, debug_traceBlockByHash,
 *   debug_traceCall, trace_filter
 *
 * This guard fails when any of those names (exact snake_case form, camelCase
 * provider-API form, or an obvious dynamically constructed form such as
 * "debug_trace" + suffix) appears in first-party executable files, including
 * committed or shipped generated executable output.
 *
 * It deliberately does NOT flag documentation (*.md), captured command
 * transcripts, historical evidence JSON, or actual dependency/vendor code.
 * Ordinary JSON-RPC usage (eth_call, eth_estimateGas, eth_getLogs,
 * eth_getTransactionReceipt, eth_getTransactionByHash, ...) is not affected
 * and is never rewritten or substituted by this guard.
 *
 * Exemptions are file-scoped: ONLY the dedicated RPC deprecation guard test
 * files (test/rpc-deprecation.test.ts, test/rpc-deprecation.test.mjs or
 * tests/rpc-deprecation.test.ts) may intentionally name the deprecated
 * methods, because those files assert the blocklist itself. No application
 * source file can suppress findings with an inline marker comment; the
 * legacy "rpc-deprecation:allow" token has no suppression effect anywhere.
 *
 * The guard's own detection list (this file) is likewise excluded by its
 * exact self path, never by content.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEPRECATED_RPC_METHODS = [
  "debug_traceTransaction",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "debug_traceCall",
  "trace_filter",
];

// Exact names, their camelCase provider-API equivalents, and obviously
// dynamic construction forms: a quoted bare "debug_trace" prefix or a
// "debug_trace" fragment immediately followed by string concatenation.
const FORBIDDEN_PATTERN = new RegExp(
  [
    "debug_trace(?:Transaction|BlockByNumber|BlockByHash|Call)",
    "trace_filter",
    "debugTrace(?:Transaction|BlockByNumber|BlockByHash|Call)",
    "traceFilter",
    "debug_trace(?=[\"'` \\t+])",
  ].join("|"),
  "g",
);

const EXECUTABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);
const FALLBACK_SKIP_DIRS = new Set([
  ".git", "node_modules", "coverage", ".eslintcache", ".local",
  "vendor", "thirdparty", "third_party",
]);
const SELF_PATH = fileURLToPath(import.meta.url);

// The dedicated test suite for this guard: the only first-party executable
// files that may intentionally contain deprecated-method references. The
// exact file name is required; look-alike paths (nested directories, src/)
// are NOT exempt.
// Keep full paths explicit; directory/extension combinations are not interchangeable.
const DEPRECATION_TEST_FILES = new Set([
  "test/rpc-deprecation.test.ts",
  "test/rpc-deprecation.test.mjs",
  "tests/rpc-deprecation.test.ts",
]);

/** True for the dedicated RPC deprecation guard test files (exact path). */
export function isDeprecationTestFile(relativePath) {
  return DEPRECATION_TEST_FILES.has(relativePath.replaceAll("\\", "/"));
}

/** True when a repository-relative path is first-party executable code. */
export function isExecutableRpcScanTarget(relativePath) {
  const normalized = relativePath.split(/[\\/]+/).join("/");
  if (/^(?:vendor|thirdparty|third_party)\//.test(normalized)) return false;
  return EXECUTABLE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

/** Canonical deprecated method label for a raw match. */
export function normalizeDeprecatedMethod(rawMatch) {
  if (rawMatch === "trace_filter" || rawMatch === "traceFilter") return "trace_filter";
  if (rawMatch.startsWith("debugTrace")) return rawMatch.replace("debugTrace", "debug_trace");
  if (rawMatch === "debug_trace") return "debug_trace* (dynamically constructed method name)";
  return rawMatch;
}

/** Line-oriented scan of arbitrary text; returns [{ line, column, method, snippet }]. */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    FORBIDDEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = FORBIDDEN_PATTERN.exec(line)) !== null) {
      const trimmed = line.trim();
      findings.push({
        line: index + 1,
        column: match.index + 1,
        method: normalizeDeprecatedMethod(match[0]),
        snippet: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed,
      });
    }
  }
  return findings;
}

function gitListing(root) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return null;
  }
}

function fallbackWalk(directory, root, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (FALLBACK_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      fallbackWalk(full, root, collected);
    } else if (entry.isFile()) {
      collected.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return collected;
}

/**
 * Scan first-party executable files of the given project. Returns
 * { findings: [{ file, line, column, method, snippet }], inspected }.
 */
export function collectProjectFindings(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const listed = gitListing(absoluteRoot);
  const relativeFiles = listed === null ? fallbackWalk(absoluteRoot, absoluteRoot, []) : listed;
  const findings = [];
  let inspected = 0;
  for (const relative of relativeFiles) {
    if (!isExecutableRpcScanTarget(relative)) continue;
    const fullPath = path.join(absoluteRoot, relative);
    if (path.resolve(fullPath) === SELF_PATH) continue;
    // File-scoped exemption: only the dedicated deprecation test files
    // assert the blocklist itself and intentionally name the methods. No
    // other file may opt out — by path or by inline comment.
    if (isDeprecationTestFile(relative)) continue;
    let text;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    inspected++;
    for (const finding of scanText(text)) {
      findings.push({ file: relative, ...finding });
    }
  }
  return { findings, inspected };
}

function main() {
  const { findings, inspected } = collectProjectFindings(process.cwd());
  const where = ` (${process.cwd()})`;
  if (findings.length !== 0) {
    process.stderr.write(
      `RPC deprecation guard FAILED: ${findings.length} deprecated trace-method reference(s) in first-party executable files${where}\n`,
    );
    for (const finding of findings) {
      process.stderr.write(`${finding.file}:${finding.line}:${finding.column}: ${finding.method} -> ${finding.snippet}\n`);
    }
    process.stderr.write(
      "debug_traceTransaction/debug_traceBlockByNumber/debug_traceBlockByHash/debug_traceCall/trace_filter are disabled on the public Pharos RPC endpoints " +
      "(https://rpc.pharos.xyz, https://testnet.dplabs-internal.com). Remove the trace usage or migrate it to an unaffected " +
      "endpoint or ordinary retrieval methods (eth_call, eth_getLogs, eth_getTransactionReceipt, ...). " +
      "The only tolerated exception is the dedicated deprecation guard test suite at the exact path " +
      "test/rpc-deprecation.test.ts, test/rpc-deprecation.test.mjs or tests/rpc-deprecation.test.ts; " +
      "inline marker comments have no suppression effect anywhere.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `RPC deprecation guard passed: ${inspected} first-party executable file(s) scanned${where}; ` +
    "no deprecated trace methods present. Documentation, transcripts/evidence and vendor code are out of scope by design. " +
    "The dedicated deprecation test files (exact paths only) and the guard's own detection list are the only exemptions.\n",
  );
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
