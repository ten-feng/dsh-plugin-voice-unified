#!/usr/bin/env node
/**
 * One-command test runner for the dsh-voice-unified Python DSP engine.
 *
 *   node tests/engine/run-tests.mjs
 *
 * It launches the Python end-to-end suite, which in turn runs every engine
 * sub-command (analyze/slice/convert/emotion/mix/similarity/demo) through the
 * real CLI and asserts the JSON fields.  Exit code is propagated.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const suite = path.join(here, "test_engine.py");

const candidates = [
  process.env.DSH_VOICE_PYTHON,
  "python",
  "python3",
];

let python = null;
for (const candidate of candidates) {
  if (!candidate) continue;
  if (candidate.includes("\\") || candidate.includes("/")) {
    if (!existsSync(candidate)) continue;
  }
  const probe = spawnSync(candidate, ["-c", "import numpy; print(numpy.__version__)"], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    python = candidate;
    break;
  }
}

if (!python) {
  console.error("[run-tests] 找不到可用的 Python + numpy 解释器（可用 DSH_VOICE_PYTHON 指定）");
  process.exit(2);
}

console.log(`[run-tests] python: ${python}`);
console.log(`[run-tests] suite : ${suite}`);
const result = spawnSync(python, [suite], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});

process.exit(result.status === null ? 1 : result.status);
