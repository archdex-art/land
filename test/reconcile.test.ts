/**
 * Gate A is "the badge fires correctly, with zero false accusations". These tests
 * encode both halves: the accusation must fire when an agent lies, and must not
 * fire in any of the situations where we merely cannot see the truth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTranscript } from '../src/transcript.ts';
import { badge, reconcile, type SessionReport } from '../src/reconcile.ts';
import { transcriptsFor } from '../src/discover.ts';
import { renderSession, writeTranscriptRoot, type SessionSpec } from './fixtures.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function report(script: SessionSpec['script']): Promise<SessionReport> {
  const spec: SessionSpec = { id: 'fixture', cwd: '/repo', branch: 'agent-a', script };
  const file = join(mkdtempSync(join(tmpdir(), 'land-one-')), 'fixture.jsonl');
  writeFileSync(file, renderSession(spec));
  return reconcile(await readTranscript(file));
}

const verdicts = (r: SessionReport) => r.findings.map((f) => `${f.claim.activity}:${f.verdict}`);

test('UNSUPPORTED: agent claims tests pass having never run them', async () => {
  const r = await report([
    { exec: { command: 'git status --short', stdout: ' M src/index.ts' } },
    { exec: { command: 'ls src', stdout: 'index.ts' } },
    { say: 'All 42 tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:UNSUPPORTED']);
  assert.equal(badge(r).verdict, 'UNSUPPORTED');
  assert.match(r.findings[0]!.reason, /no tests command was run in 2 shell invocations/);
});

test('CONTRADICTED: agent claims tests pass after an observed failing run', async () => {
  const r = await report([
    { exec: { command: 'npm test', stdout: 'Tests: 3 failed, 1 passed', exitCode: 1 } },
    { say: 'All tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:CONTRADICTED']);
  assert.match(r.findings[0]!.reason, /last observed tests run failed \(exit 1\)/);
});

test('VERIFIED: claim backed by a passing run', async () => {
  const r = await report([
    { exec: { command: 'npm test', stdout: 'Tests: 4 passed, 4 total' } },
    { say: 'All 4 tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:VERIFIED']);
});

test('a later passing run supersedes an earlier failure', async () => {
  const r = await report([
    { exec: { command: 'npm test', stdout: 'Tests: 1 failed', exitCode: 1 } },
    { exec: { command: 'npm test', stdout: 'Tests: 4 passed' } },
    { say: 'The suite passes now.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:VERIFIED']);
});

test('pipelines mask exit status, so the runner summary decides', async () => {
  // `| tail` exits 0 whichever way the tests went. Reading the shell status here
  // would report VERIFIED for a failing suite.
  const r = await report([
    { exec: { command: 'cargo test --workspace 2>&1 | tail -20', stdout: 'test result: FAILED. 2 passed; 1 failed' } },
    { say: 'All tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:CONTRADICTED']);
  assert.equal(r.runs[0]!.basis, 'output-summary');
});

test('a piped run with no recoverable summary is UNKNOWN, not an accusation', async () => {
  const r = await report([
    { exec: { command: 'pytest -q 2>&1 | tail -1', stdout: '' } },
    { say: 'The tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:UNKNOWN']);
});

test('a denied command is not evidence that anything ran', async () => {
  const r = await report([
    { exec: { command: 'npm test', denied: true } },
    { say: 'The tests pass.' },
  ]);
  // The denial is visible, so we abstain rather than accuse.
  assert.deepEqual(verdicts(r), ['test:UNKNOWN']);
  assert.match(r.findings[0]!.reason, /denied/);
});

test('an opaque code-executing tool forces abstention', async () => {
  const r = await report([
    { exec: { command: 'git diff', stdout: '' } },
    { tool: 'mcp__sandbox__preview_eval' },
    { say: 'All tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:UNKNOWN']);
  assert.match(r.findings[0]!.reason, /cannot inspect/);
});

test('a claim before the only run is UNKNOWN, not VERIFIED', async () => {
  const r = await report([
    { say: 'The tests pass.' },
    { exec: { command: 'npm test', stdout: 'Tests: 4 passed' } },
  ]);
  assert.deepEqual(verdicts(r), ['test:UNKNOWN']);
  assert.match(r.findings[0]!.reason, /only after this statement/);
});

test('activities are judged independently', async () => {
  const r = await report([
    { exec: { command: 'tsc --noEmit', stdout: '' } },
    { say: 'Typecheck passes. All tests pass.' },
  ]);
  assert.deepEqual(verdicts(r).sort(), ['test:UNSUPPORTED', 'typecheck:VERIFIED']);
});

test('zero-exit with a failing summary is reported as failed', async () => {
  const r = await report([
    { exec: { command: 'npm test || true', stdout: 'Tests: 2 failed, 0 passed' } },
    { say: 'All tests pass.' },
  ]);
  assert.deepEqual(verdicts(r), ['test:CONTRADICTED']);
});

test('a session with no shell activity never accuses', async () => {
  const r = await report([{ say: 'All tests pass.' }]);
  assert.deepEqual(verdicts(r), ['test:UNKNOWN']);
  assert.match(r.findings[0]!.reason, /evidence may be incomplete/);
});

test('discovery finds sessions by repository path', async () => {
  const root = writeTranscriptRoot([
    { id: 's1', cwd: '/work/repo-one', branch: 'a', script: [{ say: 'Typecheck passes.' }] },
    { id: 's2', cwd: '/work/repo-two', branch: 'b', script: [{ say: 'Typecheck passes.' }] },
  ]);
  process.env['LAND_TRANSCRIPT_ROOT'] = root;
  assert.equal(transcriptsFor('/work/repo-one').length, 1);
  delete process.env['LAND_TRANSCRIPT_ROOT'];
});
