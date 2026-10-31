import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// This file sits at the exact dedicated test path, so the guard exempts it as
// a whole: it intentionally names the deprecated methods to assert the
// blocklist. That exemption is granted only to this exact file name; no
// application source may opt out by inline comment or look-alike paths.
const METHODS = [
  "debug_traceTransaction",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "debug_traceCall",
  "trace_filter",
];

// The legacy inline marker: intentionally kept in this test (exempt file) to
// prove it no longer suppresses findings in application source.
const LEGACY_MARKER = "rpc-deprecation:allow";

function findProjectRoot(startPath) {
  let directory = dirname(startPath);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pharos project root with package.json not found");
    directory = parent;
  }
  return directory;
}

const PROJECT_ROOT = findProjectRoot(fileURLToPath(import.meta.url));
const GUARD = join(PROJECT_ROOT, "scripts", "check-rpc-methods.mjs");

function temporaryProject() {
  const base = join(tmpdir(), "opencode");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "rpc-deprecation-guard-"));
}

function runGuard(project) {
  return spawnSync(process.execPath, [GUARD], { cwd: project, encoding: "utf8" });
}

function guardOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const firstMethod = METHODS.find(Boolean) ?? "";

for (const method of METHODS) {
  test(`deprecated RPC trace method ${method} fails in first-party executable source`, () => {
    const project = temporaryProject();
    try {
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(
        join(project, "src", "rpc.ts"),
        `const endpoint = "https://rpc.pharos.xyz";\nclient.request({ method: "${method}", params: [] });\n`,
        "utf8",
      );
      const result = runGuard(project);
      assert.equal(result.status, 1);
      const output = guardOutput(result);
      assert.match(output, /deprecated trace-method reference|FAILED/u);
      assert.match(output, /src\/rpc\.ts:[0-9]+:[0-9]+/u);
      assert.ok(output.includes(method));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

test("deprecated method names in documentation do not fail the guard", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "docs"), { recursive: true });
    writeFileSync(join(project, "src", "chain.ts"), 'await provider.request({ method: "eth_call", params: [] });\n', "utf8");
    writeFileSync(join(project, "docs", "rpc-guide.md"), `${METHODS.join("\n")}\n`, "utf8");
    const result = runGuard(project);
    assert.equal(result.status, 0);
    assert.match(guardOutput(result), /passed/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("deprecated method names in historical evidence/transcripts do not fail the guard", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "docs", "evidence"), { recursive: true });
    writeFileSync(
      join(project, "docs", "evidence", "transcript.json"),
      `${JSON.stringify({ transcript: METHODS.join(" / ") })}\n`,
      "utf8",
    );
    const result = runGuard(project);
    assert.equal(result.status, 0);
    assert.match(guardOutput(result), /passed/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("ordinary non-trace RPC methods remain allowed", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "src", "ordinary-rpc.ts"),
      [
        'await client.request({ method: "eth_call", params: [] });',
        'await client.request({ method: "eth_getLogs", params: [] });',
        'await client.request({ method: "eth_estimateGas", params: [] });',
        'await client.request({ method: "eth_getTransactionReceipt", params: [] });',
        'await client.request({ method: "eth_getTransactionByHash", params: [] });',
      ].join("\n") + "\n",
      "utf8",
    );
    const result = runGuard(project);
    assert.equal(result.status, 0);
    assert.match(guardOutput(result), /passed/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the legacy inline marker cannot suppress application-source findings", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "src", "suppressed.ts"),
      `client.request({ method: "${firstMethod}", params: [] }); // ${LEGACY_MARKER}\n`,
      "utf8",
    );
    const result = runGuard(project);
    assert.equal(result.status, 1);
    const output = guardOutput(result);
    assert.ok(output.includes(firstMethod));
    assert.match(output, /src\/suppressed\.ts:[0-9]+:[0-9]+/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("exemptions apply only to the exact dedicated deprecation test file path", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "test", "nested"), { recursive: true });
    writeFileSync(join(project, "src", "clean.ts"), 'await client.request({ method: "eth_call", params: [] });\n', "utf8");
    // Exact dedicated path: single-file exemption.
    writeFileSync(join(project, "test", "rpc-deprecation.test.ts"), `${METHODS.join("\n")}\n`, "utf8");
    // Same-name file in the wrong location is NOT exempt.
    writeFileSync(join(project, "src", "rpc-deprecation.test.ts"), `${firstMethod}\n`, "utf8");
    // Nested look-alike paths are NOT exempt either.
    writeFileSync(join(project, "test", "nested", "rpc-deprecation.test.ts"), `${METHODS.join("\n")}\n`, "utf8");
    const result = runGuard(project);
    const output = guardOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /^src\/rpc-deprecation\.test\.ts:[0-9]+:[0-9]+/mu);
    assert.match(output, /^test\/nested\/rpc-deprecation\.test\.ts:[0-9]+:[0-9]+/mu);
    assert.doesNotMatch(output, /^test\/rpc-deprecation\.test\.ts:[0-9]/mu);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("obviously dynamically constructed method names fail too", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    const prefix = ["debug", "trace"].join("_");
    const suffix = ["Block", "By", "Number"].join("");
    writeFileSync(
      join(project, "src", "dynamic.ts"),
      `client.request({ method: "${prefix}" + "${suffix}", params: [] });\n`,
      "utf8",
    );
    const result = runGuard(project);
    assert.equal(result.status, 1);
    const output = guardOutput(result);
    assert.match(output, /dynamically constructed/u);
    assert.match(output, /src\/dynamic\.ts:1:/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("clean repository passes and the guard never flags its own patterns", () => {
  assert.equal(existsSync(GUARD), true);
  const guardSource = readFileSync(GUARD, "utf8");
  assert.ok(guardSource.includes(firstMethod));
  const result = runGuard(PROJECT_ROOT);
  assert.equal(result.status, 0);
  assert.match(guardOutput(result), /passed/u);
});
