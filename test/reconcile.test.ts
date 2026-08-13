/**
 * Gate A is "the badge fires correctly, with zero false accusations". These tests
 * encode both halves: the accusation must fire when an agent lies, and must not
 * fire in any of the situations where we merely cannot see the truth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTranscript } from '../src/transcript.ts';
import { badge, groupBranches, reconcile, type SessionReport } from '../src/reconcile.ts';
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

/*
 * The badge names the worst verdict, so its count must not imply that verdict is
 * the whole story. The old `+N more` suffix counted only same-verdict findings:
 * one contradiction beside seven unverifiable claims rendered no suffix at all.
 */
test('badge count names both the verdict total and the session total', async () => {
  const r = await report([
    { exec: { command: 'npm test', stdout: 'Tests: 3 failed, 1 passed', exitCode: 1 } },
    { say: 'All tests pass.' },
    { exec: { command: 'npm run build 2>&1 | tail -5', stdout: 'done' } },
    { say: 'The build compiles cleanly.' },
  ]);
  const b = badge(r);
  assert.equal(b.verdict, 'CONTRADICTED');
  // One CONTRADICTED among two findings — both numbers stated, neither implied.
  assert.match(b.text, /1 of 2 claims/);
});

test('badge omits the count when a session has a single finding', async () => {
  const r = await report([
    { exec: { command: 'npm test', stdout: 'Tests: 4 passed, 4 total' } },
    { say: 'All 4 tests pass.' },
  ]);
  assert.equal(badge(r).text, 'tests claimed and observed');
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

/*
 * Branch labels must be unambiguous *and* readable. Two failure modes were shipped
 * and fixed: `basename(cwd)` merged unrelated repos that share a trailing directory
 * name, and a `relative(cwd, …)` label rendered `../../../Users/me/...` and changed
 * depending on where the command was run from.
 */

/** A SessionReport with only the fields `groupBranches` reads. */
function stub(cwd: string, branch: string): SessionReport {
  return {
    session: {
      id: `${cwd}#${branch}`, file: '', cwd, gitBranch: branch,
      agentVersion: undefined, startedAt: undefined, endedAt: undefined,
      execs: [], edits: [], utterances: [], models: [], opaqueExecutors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      unparsedLines: 0,
    },
    findings: [], runs: [], observedActivities: [], risk: 'low',
  } as unknown as SessionReport;
}

test('branch labels use the shortest name that stays unambiguous', () => {
  const distinct = groupBranches([stub('/home/me/alpha', 'main'), stub('/home/me/beta', 'main')]);
  assert.deepEqual(distinct.map((r) => r.label).sort(), ['alpha/main', 'beta/main']);

  // Sharing a trailing directory name forces one more segment — but only for these.
  const collide = groupBranches([stub('/work/client/app', 'main'), stub('/work/server/app', 'main')]);
  assert.deepEqual(collide.map((r) => r.label).sort(), ['client/app/main', 'server/app/main']);

  // Each path grows only as far as it needs: `y/app` is already unique at depth 2.
  const three = groupBranches([stub('/a/x/app', 'm'), stub('/b/x/app', 'm'), stub('/c/y/app', 'm')]);
  assert.deepEqual(three.map((r) => r.label).sort(), ['a/x/app/m', 'b/x/app/m', 'y/app/m']);
});

test('repos sharing a trailing directory name are never merged', () => {
  const rows = groupBranches([stub('/work/client/app', 'main'), stub('/work/server/app', 'main')]);
  assert.equal(rows.length, 2, 'client/app and server/app are unrelated work');
});

test('labels do not depend on the current working directory', () => {
  const reports = [stub('/home/me/alpha', 'main'), stub('/var/tmp/beta', 'main')];
  const before = groupBranches(reports).map((r) => r.label);
  const original = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.deepEqual(groupBranches(reports).map((r) => r.label), before);
  } finally {
    process.chdir(original);
  }
});

test('ANSI escapes in a branch name never reach a label', () => {
  const [row] = groupBranches([stub('/r/one', '\u001B[32mmain\u001B[0m'), stub('/r/two', 'x')]);
  assert.ok(row !== undefined);
  assert.doesNotMatch(row.label, /\u001B/);
});

/*
 * Three surfaces render these rows: the terminal, the HTML report, and `--json`.
 * `--json` once emitted one entry per *session* under a key named `branches`, so
 * `land queue` reported 11 rows and `land queue --json` reported 18 for identical
 * input. Any surface that recomputes grouping will drift again, so the invariant
 * is asserted directly: one row per (repo, branch) pair, whatever the format.
 */
test('grouping collapses sessions to one row per repo and branch', () => {
  const rows = groupBranches([
    stub('/work/one', 'main'),
    stub('/work/one', 'main'),
    stub('/work/one', 'feature'),
    stub('/work/two', 'main'),
  ]);
  assert.equal(rows.length, 3, 'two sessions on one/main are one row');
  const onMain = rows.find((r) => r.label === 'one/main');
  assert.ok(onMain !== undefined);
  assert.equal(onMain.reports.length, 2, 'both sessions stay reachable from the row');
});
