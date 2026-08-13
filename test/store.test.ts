/**
 * The evidence store's two promises: nothing raw is written, and nothing written
 * can be changed without detection. Both are testable, so both are tested.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, EvidenceStore, GENESIS, linkHash } from '../src/store.ts';
import { readTranscript } from '../src/transcript.ts';
import { redact, redactAndTruncate } from '../src/redact.ts';
import { renderSession, type SessionSpec } from './fixtures.ts';

async function seeded(script: SessionSpec['script']) {
  const spec: SessionSpec = { id: 'store-fixture', cwd: '/repo', branch: 'agent-a', script };
  const file = join(mkdtempSync(join(tmpdir(), 'land-store-')), 'f.jsonl');
  writeFileSync(file, renderSession(spec));
  const store = new EvidenceStore(':memory:');
  const result = store.ingest(await readTranscript(file));
  return { store, result };
}

test('canonical form is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 4, c: 3 }] }), canonical({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.equal(canonical({ a: 1, skip: undefined }), '{"a":1}');
});

test('the chain verifies and links every event', async () => {
  const { store, result } = await seeded([
    { exec: { command: 'npm test', stdout: 'Tests: 2 passed' } },
    { say: 'All tests pass.' },
  ]);
  assert.ok(result.events > 0);
  const verified = store.verify();
  assert.equal(verified.ok, true);
  assert.equal(verified.ok && verified.events, result.events);
  assert.equal(verified.ok && verified.head, result.headHash);
  store.close();
});

test('tampering with a stored payload is detected', async () => {
  const { store } = await seeded([{ exec: { command: 'npm test', stdout: 'Tests: 2 passed' } }]);
  // Triggers forbid UPDATE, so an attacker must drop them first — exactly the
  // kind of visible act the chain exists to make pointless.
  store.db.exec('DROP TRIGGER events_no_update');
  store.db.prepare("UPDATE events SET payload = ? WHERE id = 1").run('{"command":"echo innocent"}');
  const verified = store.verify();
  assert.equal(verified.ok, false);
  assert.equal(verified.ok === false && verified.brokenAt, 1);
  store.close();
});

test('events are append-only by construction', async () => {
  const { store } = await seeded([{ exec: { command: 'npm test', stdout: 'ok' } }]);
  assert.throws(() => store.db.exec('UPDATE events SET seq = 99'), /append-only/);
  assert.throws(() => store.db.exec('DELETE FROM events'), /append-only/);
  store.close();
});

test('re-ingesting a session does not duplicate or rewrite history', async () => {
  const spec: SessionSpec = {
    id: 'dup',
    cwd: '/repo',
    branch: 'a',
    script: [{ exec: { command: 'npm test', stdout: 'Tests: 1 passed' } }],
  };
  const file = join(mkdtempSync(join(tmpdir(), 'land-dup-')), 'f.jsonl');
  writeFileSync(file, renderSession(spec));
  const store = new EvidenceStore(':memory:');
  const session = await readTranscript(file);
  const first = store.ingest(session);
  const second = store.ingest(session);
  assert.equal(second.skipped, true);
  assert.equal(second.events, 0);
  assert.equal(second.headHash, first.headHash);
  store.close();
});

test('linkHash is order-dependent, so reordering breaks the chain', () => {
  const a = linkHash(GENESIS, { x: 1 });
  const b = linkHash(a, { x: 2 });
  assert.notEqual(a, b);
  assert.notEqual(linkHash(GENESIS, { x: 2 }), b);
});

test('secrets never reach the store', async () => {
  const { store, result } = await seeded([
    {
      exec: {
        command: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls',
        stdout: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 exported',
      },
    },
  ]);
  const payloads = store.db
    .prepare("SELECT payload FROM events WHERE kind = 'exec'")
    .all()
    .map((r) => String(r['payload']))
    .join('\n');
  assert.doesNotMatch(payloads, /wJalrXUtnFEMI/);
  assert.doesNotMatch(payloads, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.match(payloads, /«redacted:/);
  assert.ok(Object.keys(result.redactions).length > 0);
  store.close();
});

test('redaction covers the credential families that matter', () => {
  const cases: Array<[string, string]> = [
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['ghp_0123456789abcdefghijklmnopqrstuvwx', 'github-token'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'anthropic-key'],
    ['AIzaSyD-1234567890abcdefghijklmnopqrstu', 'google-api-key'],
    ['postgres://user:hunter2@db.internal:5432/app', 'pg-url'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'bearer'],
    // Modern platform tokens: agents hit these during deploys and migrations.
    ['sbp_NOT_A_REAL_TOKEN_EXAMPLE_0000', 'supabase-key'],
    ['glpat-xxxxxxxxxxxxxxxxxxxx', 'gitlab-token'],
    ['SG.abcdefghij1234567890.klmnopqrst1234567890', 'sendgrid-key'],
    ['SKdeadbeefdeadbeefdeadbeefdeadbeef', 'twilio-key'],
    ['lin_api_0123456789abcdef0123456789abcdef', 'linear-key'],
    [`dop_v1_${'a'.repeat(64)}`, 'digitalocean-token'],
    [`shp${'at'}_${'deadbeef'.repeat(4)}`, 'shopify-token'],
    ['figd_abcdefghij1234567890abcd', 'figma-token'],
    [`gsk_${'a'.repeat(40)}`, 'groq-key'],
    [`xai-${'z'.repeat(40)}`, 'xai-key'],
    ['dp.pt.abcdefghij1234567890abcd', 'doppler-token'],
  ];
  for (const [secret, kind] of cases) {
    const { text, counts } = redact(`export VALUE=${secret}`);
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `leaked ${kind}`);
    assert.ok(Object.keys(counts).length > 0, `no rule fired for ${kind}`);
  }
});

test('redaction is idempotent and leaves ordinary output readable', () => {
  const once = redact('test result: ok. 66 passed; 0 failed');
  assert.equal(once.text, 'test result: ok. 66 passed; 0 failed');
  assert.equal(redact(once.text).text, once.text);
  // A commit hash is high-entropy but not a credential; redacting it would make
  // real output unreadable for no security gain.
  assert.match(redact('commit=8f14e45fceea167a5a36dedd4bea2543').text, /8f14e45f/);
});

/*
 * A redactor that mangles ordinary output is worse than one gap: users learn to
 * ignore the marker, and then a real leak reads as noise. Every line below is
 * real agent output that must survive untouched.
 */
test('ordinary high-entropy output is never redacted', () => {
  const untouched = [
    'git commit 3f2a1b8c9d4e5f6789012345678901234567890a',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'PYTHON=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Successfully built abc123def456',
    '--- FAIL: TestParse (0.00s)',
  ];
  for (const line of untouched) {
    const { text, counts } = redact(line);
    assert.equal(text, line, `mangled ordinary output: ${line}`);
    assert.equal(Object.keys(counts).length, 0, `false positive on: ${line}`);
  }
});

test('truncation happens after redaction so no secret survives at the cut', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwx';
  const padded = `${'x'.repeat(500)}${secret}${'y'.repeat(500)}`;
  const { text, truncated } = redactAndTruncate(padded, 200);
  assert.equal(truncated, true);
  assert.doesNotMatch(text, /ghp_0123/);
});
