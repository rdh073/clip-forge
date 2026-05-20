// edit-patch.test.mjs — unit tests for cf-edit JSON-patch validation
// + whitelist enforcement + apply (v0.4.0 pillar 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePatchShape, enforceWhitelist, validatePatchPayload, applyPatch,
  summarisePatch, WHITELIST,
} from './edit-patch.mjs';

test('validatePatchShape: empty patch[] is valid', () => {
  const r = validatePatchShape({ patch: [] });
  assert.equal(r.ok, true);
});

test('validatePatchShape: missing patch[] rejected', () => {
  const r = validatePatchShape({});
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].reason.includes('array'));
});

test('validatePatchShape: op with bad shape rejected', () => {
  const r = validatePatchShape({ patch: [{ op: 'wat', path: '/x' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.reason.includes('add/replace/remove')));
});

test('validatePatchShape: op missing / on path rejected', () => {
  const r = validatePatchShape({ patch: [{ op: 'replace', path: 'no-slash' }] });
  assert.equal(r.ok, false);
});

test('validatePatchShape: unknown keys on op rejected', () => {
  const r = validatePatchShape({ patch: [{ op: 'replace', path: '/x', extra: 'bad' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes('.extra')));
});

test('enforceWhitelist: /hook_overlay/text is editable', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/hook_overlay/text', value: 'X' }] });
  assert.equal(r.ok, true);
});

test('enforceWhitelist: /audio_source is FORBIDDEN', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/audio_source', value: '/x' }] });
  assert.equal(r.ok, false);
  assert.equal(r.rejected[0].reason, 'forbidden_path');
});

test('enforceWhitelist: /crop_path is FORBIDDEN', () => {
  const r = enforceWhitelist({ patch: [{ op: 'remove', path: '/crop_path' }] });
  assert.equal(r.ok, false);
});

test('enforceWhitelist: /unknown_field rejected with off_whitelist', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/random_field', value: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.rejected[0].reason, 'off_whitelist');
});

test('enforceWhitelist: /brand_kit/assets/logo allowed via prefix', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/brand_kit/assets/logo', value: {} }] });
  assert.equal(r.ok, true);
});

test('enforceWhitelist: /progress_bar/enabled allowed', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/progress_bar/enabled', value: true }] });
  assert.equal(r.ok, true);
});

test('enforceWhitelist: /target_aspect allowed', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/target_aspect', value: '16:9' }] });
  assert.equal(r.ok, true);
});

test('enforceWhitelist: forbidden path with prefix rejected', () => {
  const r = enforceWhitelist({ patch: [{ op: 'replace', path: '/source/foo', value: 1 }] });
  assert.equal(r.ok, false);
});

test('validatePatchPayload: schema_fail surfaces rejected_reason', () => {
  const r = validatePatchPayload({ patch: 'not an array' });
  assert.equal(r.ok, false);
  assert.equal(r.rejected_reason, 'schema_fail');
});

test('validatePatchPayload: off_whitelist surfaces rejected_reason', () => {
  const r = validatePatchPayload({ patch: [{ op: 'replace', path: '/audio_source', value: '/x' }] });
  assert.equal(r.ok, false);
  assert.equal(r.rejected_reason, 'off_whitelist');
});

test('validatePatchPayload: ok path returns patch + warning fields', () => {
  const r = validatePatchPayload({
    patch:   [{ op: 'replace', path: '/hook_overlay/text', value: 'NEW' }],
    warning: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.patch.length, 1);
});

test('applyPatch: replace at nested path', () => {
  const doc = { hook_overlay: { text: 'A', end_ms: 1800 } };
  const r = applyPatch(doc, [{ op: 'replace', path: '/hook_overlay/text', value: 'B' }]);
  assert.equal(r.ok, true);
  assert.equal(r.doc.hook_overlay.text, 'B');
  assert.equal(r.doc.hook_overlay.end_ms, 1800);
  // Source untouched.
  assert.equal(doc.hook_overlay.text, 'A');
});

test('applyPatch: add a new nested key', () => {
  const doc = {};
  const r = applyPatch(doc, [{ op: 'add', path: '/progress_bar/enabled', value: true }]);
  assert.equal(r.ok, true);
  assert.equal(r.doc.progress_bar.enabled, true);
});

test('applyPatch: remove a key', () => {
  const doc = { hook_overlay: { text: 'A', end_ms: 1800 } };
  const r = applyPatch(doc, [{ op: 'remove', path: '/hook_overlay/end_ms' }]);
  assert.equal(r.ok, true);
  assert.equal(r.doc.hook_overlay.text, 'A');
  assert.equal('end_ms' in r.doc.hook_overlay, false);
});

test('applyPatch: empty patch leaves doc untouched', () => {
  const doc = { x: 1, y: 2 };
  const r = applyPatch(doc, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc, doc);
});

test('applyPatch: invalid pointer rejected', () => {
  const r = applyPatch({}, [{ op: 'replace', path: 'no-leading-slash', value: 1 }]);
  assert.equal(r.ok, false);
});

test('applyPatch: composite patch applies in order', () => {
  const doc = { target_aspect: '9:16', hook_overlay: { text: 'A' } };
  const r = applyPatch(doc, [
    { op: 'replace', path: '/target_aspect', value: '16:9' },
    { op: 'replace', path: '/hook_overlay/text', value: 'NEW' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.doc.target_aspect, '16:9');
  assert.equal(r.doc.hook_overlay.text, 'NEW');
});

test('summarisePatch: produces a single line per op', () => {
  const s = summarisePatch([
    { op: 'replace', path: '/x', value: 1 },
    { op: 'remove',  path: '/y' },
  ]);
  const lines = s.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('REPLACE'));
  assert.ok(lines[1].includes('REMOVE'));
});

test('summarisePatch: empty patch returns (no changes)', () => {
  assert.equal(summarisePatch([]), '(no changes)');
});

test('WHITELIST: forbidden list contains the documented six paths', () => {
  for (const p of ['/crop_path', '/audio_source', '/clip_id', '/source', '/output', '/version']) {
    assert.ok(WHITELIST.forbidden.includes(p), p + ' must be in forbidden list');
  }
});
