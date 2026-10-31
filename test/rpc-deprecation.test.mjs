import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const ALLOWED_TEST_FILES = [
  "test/rpc-deprecation.test.ts",
  "test/rpc-deprecation.test.mjs",
  "tests/rpc-deprecation.test.ts",
];

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

function assertExemptions(files, expected) {
  const script = [
    `import { isDeprecationTestFile } from ${JSON.stringify(pathToFileURL(GUARD).href)};`,
    `const files = ${JSON.stringify(files)};`,
    "console.log(JSON.stringify(files.map((file) => ({ file, exempt: isDeprecationTestFile(file) }))));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, guardOutput(result));
  assert.deepEqual(JSON.parse(result.stdout), files.map((file) => ({ file, exempt: expected })));
}

const firstMethod = METHODS.find(Boolean) ?? "";

test("all three documented test paths are exempt with either path separator", () => {
  assertExemptions([
    ...ALLOWED_TEST_FILES,
    ...ALLOWED_TEST_FILES.map((file) => file.replaceAll("/", "\\")),
  ], true);
});

test("the fourth directory/extension combination is not exempt", () => {
  assertExemptions(["tests/rpc-deprecation.test.mjs", "tests\\rpc-deprecation.test.mjs"], false);
});

test("nested lookalikes are not exempt", () => {
  assertExemptions(ALLOWED_TEST_FILES.flatMap((file) => [
    `src/${file}`,
    `nested/${file}`,
    file.replace("/", "/nested/"),
  ]), false);
});

test("similar filenames and extensions are not exempt", () => {
  assertExemptions([
    "test/rpc-deprecation.test.js",
    "test/rpc-deprecation.test.cjs",
    "test/rpc-deprecation.test.mts",
    "test/rpc-deprecation.test.cts",
    "tests/rpc-deprecation.test.tsx",
    "tests/rpc-deprecation.test.TS",
    "tests/rpc-deprecation.spec.ts",
    "tests/rpc-deprecation.tests.ts",
    "tests/rpc-deprecation.test.ts.bak",
    "test/rpc-deprecation.test.ts.mjs",
  ], false);
});

test("path aliases and trailing characters are not exempt", () => {
  assertExemptions(ALLOWED_TEST_FILES.flatMap((file) => [
    `./${file}`,
    `/${file}`,
    file.replace("/", "//"),
    file.replace("/", "\\\\"),
    file.replace("/", "/./"),
    file.replace("/", "/nested/../"),
    `${file}\n`,
    `${file} `,
  ]), false);
});

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
      METHODS.flatMap((method) => [
        `client.request({ method: "${method}", params: [] }); // ${LEGACY_MARKER}`,
        `client.request({ method: "${method}", params: [] }); /* ${LEGACY_MARKER} */`,
      ]).join("\n") + "\n",
      "utf8",
    );
    const result = runGuard(project);
    assert.equal(result.status, 1);
    const output = guardOutput(result);
    const findings = output.split(/\r?\n/u).filter((line) => line.startsWith("src/suppressed.ts:"));
    assert.equal(findings.length, METHODS.length * 2);
    for (const method of METHODS) {
      assert.equal(findings.filter((line) => line.includes(`: ${method} ->`)).length, 2);
    }
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
    for (const file of ALLOWED_TEST_FILES) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), `${METHODS.join("\n")}\n`, "utf8");
    }
    const allowed = runGuard(project);
    assert.equal(allowed.status, 0, guardOutput(allowed));
    // Same-name file in the wrong location is NOT exempt.
    writeFileSync(join(project, "src", "rpc-deprecation.test.ts"), `${firstMethod}\n`, "utf8");
    // Nested look-alike paths are NOT exempt either.
    writeFileSync(join(project, "test", "nested", "rpc-deprecation.test.ts"), `${METHODS.join("\n")}\n`, "utf8");
    const result = runGuard(project);
    const output = guardOutput(result);
    assert.equal(result.status, 1);
    assert.match(output, /^src\/rpc-deprecation\.test\.ts:[0-9]+:[0-9]+/mu);
    assert.match(output, /^test\/nested\/rpc-deprecation\.test\.ts:[0-9]+:[0-9]+/mu);
    for (const file of ALLOWED_TEST_FILES) {
      assert.equal(output.split(/\r?\n/u).some((line) => line.startsWith(`${file}:`)), false);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the previously exempt fourth path is scanned for deprecated methods", () => {
  const project = temporaryProject();
  try {
    mkdirSync(join(project, "tests"), { recursive: true });
    writeFileSync(join(project, "tests", "rpc-deprecation.test.mjs"), `${METHODS.join("\n")}\n`, "utf8");
    const result = runGuard(project);
    assert.equal(result.status, 1, guardOutput(result));
    assert.match(guardOutput(result), /^tests\/rpc-deprecation\.test\.mjs:[0-9]+:[0-9]+/mu);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

for (const useGit of [false, true]) {
  test(`generated executable output is scanned via ${useGit ? "Git listing" : "filesystem fallback"}`, () => {
    const project = temporaryProject();
    try {
      if (useGit) {
        const init = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
        assert.equal(init.status, 0, guardOutput(init));
      }
      const generatedFiles = [
        "dist/client.js",
        "dist/module.mjs",
        "dist/common.cjs",
        "dist/tests/rpc-deprecation.test.js",
        "dist/scripts/check-rpc-methods.mjs",
      ];
      for (const file of generatedFiles) {
        mkdirSync(dirname(join(project, file)), { recursive: true });
        writeFileSync(join(project, file), METHODS.map((method) =>
          `client.request({ method: "${method}", params: [] }); // ${LEGACY_MARKER}`,
        ).join("\n") + "\n", "utf8");
      }
      const result = runGuard(project);
      assert.equal(result.status, 1, guardOutput(result));
      const lines = guardOutput(result).split(/\r?\n/u);
      for (const file of generatedFiles) {
        for (const method of METHODS) {
          assert.ok(lines.some((line) => line.startsWith(`${file}:`) && line.includes(`: ${method} ->`)), `${file}: ${method}`);
        }
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

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
