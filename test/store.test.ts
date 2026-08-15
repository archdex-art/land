/**
 * The evidence store's two promises: nothing raw is written, and nothing written
 * can be changed without detection. Both are testable, so both are tested.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, EvidenceStore, GENESIS, linkHash } from '../src/store.ts';
import { readTranscript } from '../src/transcript.ts';
import { badge, reconcile } from '../src/reconcile.ts';
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

/*
 * Fixtures below are structurally valid and semantically obvious. They have to
 * match the production regexes — that is the whole point of the test — but both
 * a scanner and a human should read them as synthetic at a glance.
 *
 * This is not hypothetical: GitHub push protection blocked an earlier version of
 * this file, reporting leaked Supabase, Twilio and Shopify credentials. The
 * fixtures were fake, but they were shaped like the real thing, which is exactly
 * what a detector is built to catch. Composing them from a visible marker keeps
 * the test honest without teaching anyone to click "allow secret".
 *
 * The marker must not *begin* with `example`: `redact` deliberately skips values
 * starting with `example`/`changeme`/`your…` as documentation placeholders, so a
 * fixture named that way would silently test nothing. Found exactly that way.
 */
const FAKE = 'NOT_A_REAL_TOKEN_EXAMPLE'; // charset A-Za-z0-9_
const FAKE_ALNUM = 'NOTAREALTOKENEXAMPLE'; // charset A-Za-z0-9, for alnum-only rules
const FAKE_HEX = 'deadbeef'; // charset a-f0-9, for hex-only rules

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
        command: `AWS_SECRET_ACCESS_KEY=${FAKE_ALNUM}${'0'.repeat(20)} aws s3 ls`,
        stdout: `token=ghp_${FAKE_ALNUM}${'0'.repeat(16)} exported`,
      },
    },
  ]);
  const payloads = store.db
    .prepare("SELECT payload FROM events WHERE kind = 'exec'")
    .all()
    .map((r) => String(r['payload']))
    .join('\n');
  assert.doesNotMatch(payloads, new RegExp(FAKE_ALNUM));
  assert.doesNotMatch(payloads, /ghp_/);
  assert.match(payloads, /«redacted:/);
  assert.ok(Object.keys(result.redactions).length > 0);
  store.close();
});

test('redaction covers the credential families that matter', () => {
  const cases: Array<[string, string]> = [
    // AWS publishes these two verbatim as documentation examples.
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    [`ghp_${FAKE_ALNUM}${'0'.repeat(16)}`, 'github-token'],
    [`sk-ant-api03-${FAKE}`, 'anthropic-key'],
    [`AIza${FAKE}___________`, 'google-api-key'],
    ['postgres://user:hunter2@db.internal:5432/app', 'pg-url'],
    [`Authorization: Bearer ${FAKE}`, 'bearer'],
    // Modern platform tokens: agents hit these during deploys and migrations.
    [`sbp_${FAKE}_0000`, 'supabase-key'],
    [`glpat-${FAKE}`, 'gitlab-token'],
    [`SG.${FAKE}.${FAKE}`, 'sendgrid-key'],
    [`SK${FAKE_HEX.repeat(4)}`, 'twilio-key'],
    [`lin_api_${FAKE_ALNUM}${'0'.repeat(12)}`, 'linear-key'],
    [`dop_v1_${FAKE_HEX.repeat(8)}`, 'digitalocean-token'],
    [`shpat_${FAKE_HEX.repeat(4)}`, 'shopify-token'],
    [`figd_${FAKE}`, 'figma-token'],
    [`gsk_${FAKE_ALNUM}${'0'.repeat(20)}`, 'groq-key'],
    [`xai-${FAKE_ALNUM}${'0'.repeat(20)}`, 'xai-key'],
    [`dp.pt.${FAKE}`, 'doppler-token'],
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
  const secret = `ghp_${FAKE_ALNUM}${'0'.repeat(16)}`;
  const padded = `${'x'.repeat(500)}${secret}${'y'.repeat(500)}`;
  const { text, truncated } = redactAndTruncate(padded, 200);
  assert.equal(truncated, true);
  assert.doesNotMatch(text, new RegExp(FAKE_ALNUM));
});

/*
 * The store is only worth having if it can be *read*. These tests cover the
 * promise that a stored session yields the same verdict as a live parse, and the
 * bug that made that false: a session ingested while the agent was still working
 * was frozen at that moment, and every later event — including the lie that
 * makes it CONTRADICTED — was silently discarded forever.
 */

test('a stored session reconciles to the same verdict as a live parse', async () => {
  const script: SessionSpec['script'] = [
    { exec: { command: 'ruff check src', stdout: 'Found 1 error.', exitCode: 1 } },
    { say: 'Lint clean, all green.' },
  ];
  const spec: SessionSpec = { id: 'roundtrip', cwd: '/repo', branch: 'agent-a', script };
  const file = join(mkdtempSync(join(tmpdir(), 'land-rt-')), 'f.jsonl');
  writeFileSync(file, renderSession(spec));

  const session = await readTranscript(file);
  const liveBadge = badge(reconcile(session));

  const store = new EvidenceStore(':memory:');
  store.ingest(session);
  const stored = store.read();
  assert.equal(stored.length, 1);

  const storedBadge = badge(reconcile(stored[0]!.session, stored[0]!.claims));
  assert.equal(storedBadge.verdict, liveBadge.verdict);
  assert.equal(storedBadge.text, liveBadge.text);
  assert.equal(storedBadge.verdict, 'CONTRADICTED');
  store.close();
});

test('re-ingesting a grown transcript appends only its new events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-grow-'));
  const file = join(dir, 'f.jsonl');
  const store = new EvidenceStore(':memory:');

  // The session as it looked mid-flight: a passing test run, honestly reported.
  const early: SessionSpec = {
    id: 'growing', cwd: '/repo', branch: 'agent-a',
    script: [{ exec: { command: 'npm test', stdout: 'Tests: 2 passed' } }, { say: 'All tests pass.' }],
  };
  writeFileSync(file, renderSession(early));
  const first = store.ingest(await readTranscript(file));
  assert.equal(first.skipped, false);
  assert.equal(first.appended, false);

  // The agent kept working and then lied about lint.
  const grown: SessionSpec = {
    id: 'growing', cwd: '/repo', branch: 'agent-a',
    script: [
      { exec: { command: 'npm test', stdout: 'Tests: 2 passed' } },
      { say: 'All tests pass.' },
      { exec: { command: 'ruff check src', stdout: 'Found 1 error.', exitCode: 1 } },
      { say: 'Lint clean.' },
    ],
  };
  writeFileSync(file, renderSession(grown));
  const second = store.ingest(await readTranscript(file));
  assert.equal(second.appended, true, 'the tail must be appended, not discarded');
  assert.ok(second.events > 0);

  // The store must now convict, exactly as a live parse of the full transcript does.
  const stored = store.read()[0]!;
  assert.equal(badge(reconcile(stored.session, stored.claims)).verdict, 'CONTRADICTED');
  assert.equal(store.verify().ok, true, 'appending must not break the chain');

  // And a third pass with no further change adds nothing.
  const third = store.ingest(await readTranscript(file));
  assert.equal(third.skipped, true);
  assert.equal(third.events, 0);
  store.close();
});

test('seenFile skips only a byte-identical transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-seen-'));
  const file = join(dir, 'f.jsonl');
  const spec: SessionSpec = {
    id: 'seen', cwd: '/repo', branch: 'agent-a',
    script: [{ exec: { command: 'npm test', stdout: 'Tests: 1 passed' } }, { say: 'The test passes.' }],
  };
  writeFileSync(file, renderSession(spec));

  const store = new EvidenceStore(':memory:');
  const stat = statSync(file);
  store.ingest(await readTranscript(file), { size: stat.size, mtime: String(stat.mtimeMs) });

  assert.equal(store.seenFile(file, stat.size, String(stat.mtimeMs)), true);
  // Any change to size or mtime must force a parse rather than a skip.
  assert.equal(store.seenFile(file, stat.size + 1, String(stat.mtimeMs)), false);
  assert.equal(store.seenFile(file, stat.size, '0'), false);
  assert.equal(store.seenFile('/nowhere/else.jsonl', stat.size, String(stat.mtimeMs)), false);
  store.close();
});

test('store filters narrow by repo, branch, and session prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-filter-'));
  const store = new EvidenceStore(':memory:');
  for (const [id, cwd, branch] of [
    ['aaa-one', '/work/alpha', 'main'],
    ['bbb-two', '/work/beta', 'main'],
    ['ccc-three', '/work/alpha', 'feature'],
  ] as const) {
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, renderSession({ id, cwd, branch, script: [{ say: 'All tests pass.' }] }));
    store.ingest(await readTranscript(file));
  }

  assert.equal(store.read().length, 3);
  assert.equal(store.read({ repo: '/work/alpha' }).length, 2);
  assert.equal(store.read({ branch: 'feature' }).length, 1);
  assert.equal(store.read({ repo: '/work/alpha', branch: 'main' }).length, 1);
  assert.equal(store.read({ session: 'bbb' }).length, 1);
  assert.equal(store.read({ session: 'zzz' }).length, 0);
  store.close();
});
