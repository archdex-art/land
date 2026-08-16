/**
 * The CI gate's contract. Two things here are load-bearing and neither is
 * cosmetic: the policy decides whether a build is allowed to merge, and the
 * workflow-command escaping decides whether agent-authored text can inject a
 * command into a runner's log stream.
 *
 * A gate that silently stops gating is worse than no gate at all, because the
 * green check is then a lie the whole pipeline trusts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscript } from '../src/transcript.ts';
import { reconcile, type SessionReport } from '../src/reconcile.ts';
import { annotations, evaluate, isPolicy, outputs, summary, type CiResult, type Policy } from '../src/ci.ts';
import { renderSession, type SessionSpec } from './fixtures.ts';

async function report(script: SessionSpec['script'], branch = 'agent-a'): Promise<SessionReport> {
  const spec: SessionSpec = { id: `ci-${branch}`, cwd: '/repo', branch, script };
  const file = join(mkdtempSync(join(tmpdir(), 'land-ci-')), 'f.jsonl');
  writeFileSync(file, renderSession(spec));
  return reconcile(await readTranscript(file));
}

/** An agent that claimed lint passed after an observed lint failure. */
const LIED: SessionSpec['script'] = [
  { exec: { command: 'ruff check src', stdout: 'Found 1 error.', exitCode: 1 } },
  { say: 'Lint clean, all green.' },
];

/** An agent that claimed tests pass, having never run them. */
const UNSUPPORTED: SessionSpec['script'] = [
  { exec: { command: 'git status --short', stdout: ' M src/a.py' } },
  { say: 'All 12 tests pass.' },
];

/** An honest agent. */
const HONEST: SessionSpec['script'] = [
  { exec: { command: 'npm test', stdout: 'Tests: 4 passed, 4 total' } },
  { say: 'All 4 tests pass.' },
];

const full = (r: Omit<CiResult, 'chain'>, chain?: CiResult['chain']): CiResult => ({ ...r, chain });

test('the default policy fails a contradiction and nothing weaker', async () => {
  const contradicted = evaluate([await report(LIED)], 'contradicted');
  assert.equal(contradicted.violations.length, 1);
  assert.equal(contradicted.violations[0]!.verdict, 'CONTRADICTED');

  // An honest branch and an unverifiable one must both pass the default gate,
  // or nobody can adopt this on a real repository.
  const honest = evaluate([await report(HONEST)], 'contradicted');
  assert.equal(honest.violations.length, 0);
});

test('a stricter policy is a superset, never a different set', async () => {
  const reports = [await report(LIED, 'a'), await report(UNSUPPORTED, 'b'), await report(HONEST, 'c')];
  const counts: Record<Policy, number> = {
    contradicted: evaluate(reports, 'contradicted').violations.length,
    unsupported: evaluate(reports, 'unsupported').violations.length,
    unknown: evaluate(reports, 'unknown').violations.length,
    never: evaluate(reports, 'never').violations.length,
  };
  assert.equal(counts.never, 0, 'never must never fail');
  assert.ok(counts.contradicted >= 1);
  assert.ok(
    counts.unsupported >= counts.contradicted,
    'an unsupported claim is a stronger accusation than a contradicted one, not a weaker one',
  );
  assert.ok(counts.unknown >= counts.unsupported);
});

test('an unrecognised policy name is rejected, never defaulted', () => {
  assert.equal(isPolicy('contradicted'), true);
  assert.equal(isPolicy('never'), true);
  // The dangerous cases: plausible near-misses that must not silently pass.
  assert.equal(isPolicy('contradictions'), false);
  assert.equal(isPolicy('CONTRADICTED'), false);
  assert.equal(isPolicy(''), false);
  assert.equal(isPolicy('all'), false);
});

/*
 * The attacker-controlled field is the *branch name*, not the agent's prose.
 * Annotation bodies are built from our own generated summary text, but the label
 * comes from `gitBranch` in the transcript — arbitrary JSON that `land` treats as
 * untrusted external input by design. A crafted transcript is therefore a path to
 * forging workflow commands in a runner's log stream.
 *
 * An earlier version of this test used a malicious *claim sentence* and passed
 * even with escaping deleted, because that text never reaches an annotation. It
 * was proving nothing.
 */
test('a crafted branch name cannot forge a workflow command', async () => {
  const nasty = 'main::error title=forged::owned,x\n::error::second';
  const r = await report(LIED, nasty);
  const lines = annotations(full(evaluate([r], 'contradicted')));

  assert.equal(lines.length, 1, 'one violation must produce exactly one command');
  const line = lines[0]!;
  assert.equal(line.split('\n').length, 1, 'a raw newline would end the command and start a log line');

  // Exactly two `::` may appear structurally: the command prefix and the body
  // separator. Anything more means an injected delimiter survived.
  assert.equal((line.match(/::/g) ?? []).length, 2, 'an unescaped :: could open a second command');

  /*
   * Properties are `name=value` pairs separated by `,`, parsed only between the
   * command name and the body separator. The injected text therefore cannot
   * introduce a new property unless a raw `,` survives — so that, not the
   * presence of the string `title=`, is the invariant. `title=forged` sitting
   * inside a property *value* is inert text.
   */
  const properties = line.slice('::error '.length, line.indexOf('::', 2));
  assert.doesNotMatch(properties, /,/, 'a raw comma would open a second, attacker-chosen property');
  assert.match(properties, /%2C/, 'the injected comma must be encoded');
  assert.match(properties, /^title=land%3A CONTRADICTED on main%3A%3A/, 'our own title must still lead');
  assert.match(line, /%0A/, 'the newline must be encoded, not dropped');
});

test('annotations escalate a broken chain above any policy verdict', async () => {
  const clean = full(evaluate([await report(HONEST)], 'contradicted'), { ok: false, events: 0, brokenAt: 7 });
  const lines = annotations(clean);
  assert.equal(lines.length, 1, 'no policy violation, but the chain break must still be reported');
  assert.match(lines[0]!, /^::error /);
  assert.match(lines[0]!, /diverges at event 7/);
});

test('step outputs are heredoc-delimited so no value can break the format', async () => {
  const result = full(evaluate([await report(LIED)], 'contradicted'), { ok: true, events: 12 });
  const text = outputs(result);

  // Every key uses the heredoc form; the single-line form is a hole waiting for
  // a value with a newline in it.
  for (const key of ['passed', 'worst-verdict', 'violations', 'chain-ok']) {
    assert.match(text, new RegExp(`^${key}<<land_${key}_eof$`, 'm'), `${key} must use the heredoc form`);
  }
  assert.match(text, /^passed<<land_passed_eof\nfalse\nland_passed_eof$/m);
  assert.match(text, /^worst-verdict<<land_worst-verdict_eof\nCONTRADICTED\nland_worst-verdict_eof$/m);
  assert.ok(text.endsWith('\n'));
});

test('the summary states the gate it applied and what to read', async () => {
  const result = full(evaluate([await report(LIED)], 'contradicted'), { ok: true, events: 12 });
  const md = summary(result, 'contradicted', 'report.html');

  assert.match(md, /needs reading/, 'one violation takes a singular verb');
  assert.doesNotMatch(md, /branch need reading/);
  assert.match(md, /--fail-on contradicted/, 'a reader must be able to see which gate ran');
  assert.match(md, /Read these first/);
  assert.match(md, /report\.html/);
  assert.match(md, /Evidence chain intact — 12 events verified\./);
});

test('a clean run says so affirmatively rather than showing an empty table', async () => {
  const result = full(evaluate([await report(HONEST)], 'contradicted'), { ok: true, events: 4 });
  const md = summary(result, 'contradicted', undefined);
  assert.match(md, /every execution claim holds up/);
  assert.doesNotMatch(md, /Read these first/);
  // An all-clear that reports no numbers leaves a reader unsure it ran at all.
  assert.match(md, /\| ✓ Verified \| 1 \|/);
});
