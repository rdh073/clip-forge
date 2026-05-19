#!/usr/bin/env node
// bump-version.mjs — single-shot release helper.
//
// Bumps version in plugin.json + package.json + marketplace.json, moves the
// CHANGELOG [Unreleased] entries into a versioned section, creates a chore
// commit, and tags the commit. Does NOT push — caller decides.
//
// Usage:
//   node scripts/bump-version.mjs patch       # 0.1.1 → 0.1.2
//   node scripts/bump-version.mjs minor       # 0.1.1 → 0.2.0
//   node scripts/bump-version.mjs major       # 0.1.1 → 1.0.0
//   node scripts/bump-version.mjs 0.1.5       # explicit version
//
// Guards (refuses unless --force):
//   1. Working tree must be clean (no staged/unstaged changes).
//   2. `npm test` must pass.
//   3. `claude plugin validate .` must pass.
//   4. If `gh` is installed AND a remote is set: check CI status of HEAD.
//        success    → proceed
//        in_progress → refuse, wait for CI
//        failure    → refuse, fix CI first
//        not found  → warn (commit hasn't been pushed yet), proceed
//   5. New version must be greater than the latest git tag (semver-strict).
//
// On success: prints the exact next-step push command.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));
const KIND = positional[0]; // patch | minor | major | explicit "X.Y.Z"

function die(msg, code = 1) {
  process.stderr.write('bump-version: ' + msg + '\n');
  process.exit(code);
}

function ok(msg)  { process.stdout.write('  ✅ ' + msg + '\n'); }
function warn(msg){ process.stdout.write('  ⚠  ' + msg + '\n'); }
function info(msg){ process.stdout.write('  ⏳ ' + msg + '\n'); }
function step(msg){ process.stdout.write('\n▶ ' + msg + '\n'); }

function which(cmd) {
  const r = spawnSync('sh', ['-c', 'command -v ' + cmd], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function git(...gitArgs) {
  const r = spawnSync('git', gitArgs, { encoding: 'utf-8', cwd: ROOT });
  if (r.status !== 0) throw new Error('git ' + gitArgs.join(' ') + ': ' + r.stderr.trim());
  return r.stdout.trim();
}

function parseSemver(s) {
  const m = String(s || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: m[0] };
}

function cmpSemver(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function bump(cur, kind) {
  if (parseSemver(kind)) return parseSemver(kind);
  if (kind === 'patch') return { major: cur.major, minor: cur.minor, patch: cur.patch + 1 };
  if (kind === 'minor') return { major: cur.major, minor: cur.minor + 1, patch: 0 };
  if (kind === 'major') return { major: cur.major + 1, minor: 0, patch: 0 };
  die('first arg must be patch|minor|major or X.Y.Z (got "' + kind + '")', 2);
}

function fmt(v) { return v.major + '.' + v.minor + '.' + v.patch; }
function today() { return new Date().toISOString().slice(0, 10); }

// ---- guard helpers ----

function checkWorkingTreeClean() {
  const dirty = git('status', '--porcelain');
  if (dirty.length === 0) { ok('working tree clean'); return true; }
  warn('working tree has uncommitted changes:\n' + dirty);
  return false;
}

function runCmd(label, cmd, cmdArgs) {
  info(label);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { warn(label + ' FAILED'); return false; }
  ok(label + ' passed');
  return true;
}

function checkCI() {
  if (!which('gh')) { warn('gh not installed — skipping CI status check'); return true; }
  const remote = (() => { try { return git('remote', 'get-url', 'origin'); } catch { return ''; } })();
  if (!remote) { warn('no `origin` remote — skipping CI status check'); return true; }
  const sha = git('rev-parse', 'HEAD');
  const r = spawnSync('gh', ['run', 'list', '--commit', sha, '--limit', '1',
                              '--json', 'status,conclusion'], { encoding: 'utf-8', cwd: ROOT });
  if (r.status !== 0) { warn('gh run list failed: ' + r.stderr.trim().slice(0, 200) + ' — proceeding without CI check'); return true; }
  let runs;
  try { runs = JSON.parse(r.stdout); } catch { warn('gh returned unparseable JSON — skipping check'); return true; }
  if (!Array.isArray(runs) || runs.length === 0) {
    warn('no CI run for HEAD ' + sha.slice(0, 7) + ' yet — this is fine if you haven\'t pushed');
    return true;
  }
  const run = runs[0];
  if (run.status !== 'completed') { warn('CI run still ' + run.status + ' on HEAD — refusing to bump'); return false; }
  if (run.conclusion !== 'success') { warn('CI conclusion=' + run.conclusion + ' on HEAD — refusing to bump'); return false; }
  ok('CI green on HEAD');
  return true;
}

// ---- changelog helpers ----

function updateChangelog(newVersion) {
  const path = resolve(ROOT, 'CHANGELOG.md');
  const src = readFileSync(path, 'utf-8');
  const dateStr = today();

  // Find [Unreleased] header
  const unreleasedHeader = '## [Unreleased]';
  const idx = src.indexOf(unreleasedHeader);
  if (idx === -1) {
    throw new Error('CHANGELOG.md is missing the "## [Unreleased]" header');
  }
  // Extract body of [Unreleased]: from the end of that header to the next "## "
  const after = src.slice(idx + unreleasedHeader.length);
  const nextHeader = after.search(/\n## \[/);
  const body = (nextHeader === -1 ? after : after.slice(0, nextHeader)).trim();

  if (!body) {
    throw new Error('CHANGELOG [Unreleased] is empty — fill in changes before bumping');
  }

  // Build the new section
  const newSection = '## [' + newVersion + '] - ' + dateStr + '\n\n' + body + '\n';

  // Replace the body of [Unreleased] with empty, and inject the new section below it
  const out = src.slice(0, idx + unreleasedHeader.length) + '\n\n' + newSection + (nextHeader === -1 ? '' : after.slice(nextHeader));
  writeFileSync(path, out);
  return { dateStr, body };
}

function bumpManifests(newVersion) {
  const targets = ['.claude-plugin/plugin.json', 'package.json', 'marketplace.json'];
  for (const rel of targets) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) { warn(rel + ' missing — skipping'); continue; }
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    j.version = newVersion;
    writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
    ok(rel + ' → ' + newVersion);
  }
}

// ---- main ----

if (!KIND) die('first arg must be patch|minor|major or X.Y.Z\n' +
                'example: node scripts/bump-version.mjs patch', 2);

step('Guards');

if (!checkWorkingTreeClean()) {
  if (!FORCE) die('working tree dirty — commit changes first (or pass --force)');
  warn('--force: proceeding despite dirty tree');
}

if (!runCmd('npm test', 'npm', ['test', '--silent'])) {
  if (!FORCE) die('npm test failed — fix tests first (or pass --force)');
  warn('--force: proceeding despite test failure');
}

if (!runCmd('claude plugin validate .', 'claude', ['plugin', 'validate', '.'])) {
  if (!FORCE) die('plugin validate failed (or pass --force)');
  warn('--force: proceeding despite validate failure');
}

if (!checkCI()) {
  if (!FORCE) die('CI check failed — wait for green or pass --force');
}

step('Compute next version');

let latestTag;
try { latestTag = git('describe', '--tags', '--abbrev=0'); } catch { latestTag = null; }
const currentFromTag = parseSemver(latestTag) || { major: 0, minor: 0, patch: 0 };
ok('latest tag: ' + (latestTag || '(none)') + ' → parsed ' + fmt(currentFromTag));

const next = bump(currentFromTag, KIND);
const nextStr = fmt(next);
ok('bumping to: v' + nextStr);

if (cmpSemver(next, currentFromTag) <= 0) {
  die('new version v' + nextStr + ' is not greater than latest tag v' + fmt(currentFromTag));
}

step('Update manifests + CHANGELOG');
bumpManifests(nextStr);
const { dateStr, body } = updateChangelog(nextStr);
ok('CHANGELOG: moved [Unreleased] entries → [' + nextStr + '] - ' + dateStr);

step('Commit + tag');
git('add', '.claude-plugin/plugin.json', 'package.json', 'marketplace.json', 'CHANGELOG.md');
git('commit', '-m', 'chore: bump version to ' + nextStr);
ok('committed');

const tagMsg = 'v' + nextStr + ' — see CHANGELOG.md for details\n\n' + body;
const tagFile = '/tmp/cf-bump-tag-' + Date.now() + '.txt';
writeFileSync(tagFile, tagMsg);
git('tag', '-a', 'v' + nextStr, '-F', tagFile);
spawnSync('rm', ['-f', tagFile]);
ok('tagged v' + nextStr);

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
step('Done. Push with:');
process.stdout.write('\n  git push origin ' + branch + ' v' + nextStr + '\n\n');
