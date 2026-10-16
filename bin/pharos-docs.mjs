#!/usr/bin/env node
/**
 * `pharos-docs` executable wrapper.
 *
 * All behaviour lives in ../src/cli.mjs (which is injectable and unit tested). This file only
 * forwards argv and maps the returned code onto the process exit status.
 */

import process from "node:process";
import { runCli } from "../src/cli.mjs";

process.on("SIGINT", () => {
  process.stderr.write("\ninterrupted\n");
  process.exit(130);
});

process.exitCode = await runCli(process.argv.slice(2));
