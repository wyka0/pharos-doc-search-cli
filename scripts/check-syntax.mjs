#!/usr/bin/env node
/**
 * Syntax check for every JavaScript module in the project.
 *
 * This is the project's static gate (`npm run check`): Node's own parser, no third-party
 * linter or formatter is configured. Files are listed explicitly so a stray file cannot
 * silently escape the check.
 */

import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["bin", "src", "test", "scripts"];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.m?js$/.test(entry)) files.push(full);
  }
  return files;
}

const files = DIRS.flatMap((d) => {
  const full = path.join(root, d);
  try {
    return statSync(full).isDirectory() ? walk(full) : [];
  } catch {
    return [];
  }
});

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write(`${path.relative(root, file)}\n${res.stderr}`);
  }
}

console.log(`${files.length - failed}/${files.length} files passed syntax check.`);
process.exit(failed > 0 ? 1 : 0);
