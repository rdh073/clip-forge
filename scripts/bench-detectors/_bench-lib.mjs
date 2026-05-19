// _bench-lib.mjs — shared helpers for scripts/bench-detectors/*.mjs.
//
// Each bench script installs ONE candidate library into a fresh temp directory
// (no pollution of the plugin's root package.json), runs a small inline
// runner.mjs against tests/fixtures/sample-face.jpg, and emits a JSON record
// describing init time, detection latency, install size, and Node compatibility.
//
// Helpers here keep the per-library scripts identical in shape.

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
export const SAMPLE_PATH = resolve(PLUGIN_ROOT, 'tests/fixtures/sample-face.jpg');

export function fmtErr(stdout, stderr, label) {
  return {
    library: label,
    works_in_node: false,
    error: 'runner_failed',
    stdout_tail: (stdout || '').split('\n').slice(-15).join('\n'),
    stderr_tail: (stderr || '').split('\n').slice(-15).join('\n'),
  };
}

/**
 * Run a candidate bench end-to-end.
 *
 * @param {object} cfg
 * @param {string} cfg.label             Human-readable library name
 * @param {string[]} cfg.installArgs     args after `npm install` (e.g. ["@vladmandic/human"])
 * @param {string} cfg.runnerSource      ESM source of the runner; receives import.meta.argv[2] = sample path
 * @param {number} [cfg.installTimeoutMs=300_000]
 * @param {number} [cfg.runTimeoutMs=180_000]
 */
export async function runBench(cfg) {
  const tempDir = mkdtempSync(join(tmpdir(), 'cf-bench-'));
  process.stderr.write('[' + cfg.label + '] temp: ' + tempDir + '\n');
  let result;
  try {
    // 1. npm init + install
    spawnSync('npm', ['init', '-y'], { cwd: tempDir, stdio: 'ignore' });
    const installStart = Date.now();
    process.stderr.write('[' + cfg.label + '] installing: npm install ' + cfg.installArgs.join(' ') + '\n');
    const inst = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--silent', ...cfg.installArgs], {
      cwd: tempDir,
      timeout: cfg.installTimeoutMs ?? 300_000,
      encoding: 'utf-8',
    });
    const installMs = Date.now() - installStart;
    if (inst.status !== 0) {
      return { library: cfg.label, works_in_node: false, error: 'install_failed',
               install_stderr_tail: (inst.stderr || '').split('\n').slice(-10).join('\n'),
               install_ms: installMs };
    }

    // 2. install size
    const du = spawnSync('du', ['-sm', 'node_modules'], { cwd: tempDir, encoding: 'utf-8' });
    const installSizeMb = parseInt((du.stdout || '0').split(/\s+/)[0], 10) || 0;
    process.stderr.write('[' + cfg.label + '] installed ' + installSizeMb + ' MB in ' + installMs + ' ms\n');

    // 3. write runner.mjs and execute
    writeFileSync(join(tempDir, 'runner.mjs'), cfg.runnerSource);
    process.stderr.write('[' + cfg.label + '] running detect bench…\n');
    const run = spawnSync('node', ['runner.mjs', SAMPLE_PATH], {
      cwd: tempDir,
      timeout: cfg.runTimeoutMs ?? 180_000,
      encoding: 'utf-8',
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });

    if (run.status !== 0) {
      result = fmtErr(run.stdout, run.stderr, cfg.label);
    } else {
      try {
        const m = run.stdout.match(/\{[\s\S]*\}\s*$/);
        if (!m) throw new Error('no JSON in stdout');
        result = JSON.parse(m[0]);
      } catch (e) {
        result = fmtErr(run.stdout, run.stderr, cfg.label);
        result.parse_error = e.message;
      }
    }
    result.install_size_mb = installSizeMb;
    result.install_ms = installMs;
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  return result;
}

export function printAndExit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.works_in_node ? 0 : 1);
}
