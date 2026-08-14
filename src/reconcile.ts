/**
 * Claimed-vs-observed reconciliation — the product's one accusation.
 *
 * Gate A is "zero false accusations", so this module is built around abstention.
 * There are four verdicts and only one of them is an accusation:
 *
 *   VERIFIED      the claim is backed by an observed run that we can see succeeded
 *   CONTRADICTED  an observed run of that activity failed, and the agent said it passed
 *   UNSUPPORTED   no run of that activity appears anywhere in the session  ← the badge
 *   UNKNOWN       we cannot tell, and we say so rather than pick a side
 *
 * UNSUPPORTED is emitted only when every escape route is closed: the agent
 * demonstrably had and used shell access, no segment of any command it ran
 * matched the claimed activity, and the session contains no tool that could have
 * executed the activity invisibly to us. If any of those fails, the verdict is
 * UNKNOWN. That is the difference between a product a reviewer trusts and one
 * they mute.
 */

import { analyze, verdictFromOutput, type Activity } from './commands.ts';
import { claimsFromSession, type Claim, type ClaimActivity } from './claims.ts';
import type { ExecEvent, Session } from './transcript.ts';

export type Verdict = 'VERIFIED' | 'CONTRADICTED' | 'UNSUPPORTED' | 'UNKNOWN';

export interface ObservedRun {
  command: string;
  activity: Activity;
  outcome: 'passed' | 'failed' | 'indeterminate';
  /** Why we believe the outcome: exit status, runner summary, or neither. */
  basis: 'exit-status' | 'output-summary' | 'none';
  exitCode: number | null;
  seq: number;
  ts: string | undefined;
}

export interface Finding {
  claim: Claim;
  verdict: Verdict;
  /** One line, always present. The UI shows this and nothing else by default. */
  reason: string;
  /** Runs that informed the verdict, most relevant first. */
  evidence: ObservedRun[];
}

export interface SessionReport {
  session: Session;
  runs: ObservedRun[];
  findings: Finding[];
  /** Activities the agent actually exercised, regardless of what it claimed. */
  observedActivities: Activity[];
  /** Highest-severity signal in this session, for sorting a queue. */
  risk: 'high' | 'medium' | 'low';
}

/**
 * Decide the outcome of one observed run.
 *
 * Exit status is authoritative only when the classified segment is the last
 * stage of its pipeline. `cargo test 2>&1 | tail -20` exits with tail's status,
 * which is 0 whether or not a single test passed — reading it would manufacture
 * a "VERIFIED" out of nothing. In that case the runner's own summary text is the
 * only honest source, and if that is absent the run is indeterminate.
 */
function outcomeOf(
  exec: ExecEvent,
  activity: Activity,
  statusMasked: boolean,
  multiActivity: boolean,
): Pick<ObservedRun, 'outcome' | 'basis'> {
  if (exec.outcome === 'denied' || exec.outcome === 'interrupted') return { outcome: 'indeterminate', basis: 'none' };

  const fromOutput = verdictFromOutput(`${exec.stdout}\n${exec.stderr}`, activity);

  // With two classified activities in one invocation the shell's status belongs
  // to whichever ran last, so it cannot be attributed to this activity. The
  // activity-scoped output signs still can be.
  if (!statusMasked && !multiActivity && exec.exitCode !== null) {
    const fromStatus = exec.exitCode === 0 ? 'passed' : 'failed';
    // A zero exit with a failing summary means the command swallowed the
    // failure. Trust the more pessimistic of the two: under-claiming success is
    // the safe direction for a trust product.
    if (fromStatus === 'passed' && fromOutput === 'failed') return { outcome: 'failed', basis: 'output-summary' };
    return { outcome: fromStatus, basis: 'exit-status' };
  }
  if (fromOutput !== 'none') return { outcome: fromOutput, basis: 'output-summary' };
  return { outcome: 'indeterminate', basis: 'none' };
}

/**
 * Every classified run in a session, in transcript order.
 *
 * A denied command is excluded outright. It appears in the transcript as a
 * `tool_result`, but nothing executed, so admitting it would let a refused
 * `npm test` stand as evidence *supporting* a claim that tests passed — a false
 * VERIFIED, which is worse than a false accusation because nobody looks twice.
 */
export function observedRuns(session: Session): ObservedRun[] {
  const runs: ObservedRun[] = [];
  for (const exec of session.execs) {
    if (exec.outcome === 'denied') continue;
    const { segments, activities } = analyze(exec.command);
    const multiActivity = activities.length > 1;
    /** One run per distinct activity in the command, not per segment. */
    const seen = new Set<Activity>();
    for (const segment of segments) {
      if (segment.activity === 'other' || seen.has(segment.activity)) continue;
      seen.add(segment.activity);
      const { outcome, basis } = outcomeOf(exec, segment.activity, segment.statusMasked, multiActivity);
      runs.push({
        command: exec.command,
        activity: segment.activity,
        outcome,
        basis,
        exitCode: exec.exitCode,
        seq: exec.seq,
        ts: exec.ts,
      });
    }
  }
  return runs;
}

const LABEL: Record<ClaimActivity, string> = {
  test: 'tests',
  build: 'build',
  typecheck: 'typecheck',
  lint: 'lint',
};

function judge(claim: Claim, runs: ObservedRun[], session: Session): Finding {
  const label = LABEL[claim.activity];
  // Only runs at or before the claim can support it. Equal sequence numbers are
  // allowed because a single assistant message holds both its prose and its
  // tool calls on one transcript line.
  const prior = runs.filter((r) => r.activity === claim.activity && r.seq <= claim.seq);

  if (prior.length === 0) {
    const later = runs.some((r) => r.activity === claim.activity);
    if (later) {
      return {
        claim,
        verdict: 'UNKNOWN',
        reason: `${label} ran only after this statement — cannot tell what it referred to`,
        evidence: runs.filter((r) => r.activity === claim.activity).slice(0, 3),
      };
    }
    if (session.execs.length === 0) {
      return {
        claim,
        verdict: 'UNKNOWN',
        reason: 'no shell activity recorded in this transcript — evidence may be incomplete',
        evidence: [],
      };
    }
    if (session.opaqueExecutors.length > 0) {
      return {
        claim,
        verdict: 'UNKNOWN',
        reason: `no ${label} command observed, but ${session.opaqueExecutors.join(', ')} can execute code we cannot inspect`,
        evidence: [],
      };
    }
    const denied = session.execs.some((e) => e.outcome === 'denied');
    if (denied) {
      return {
        claim,
        verdict: 'UNKNOWN',
        reason: `no ${label} command observed, and at least one command was denied before it could run`,
        evidence: [],
      };
    }
    return {
      claim,
      verdict: 'UNSUPPORTED',
      reason: `claimed ${label} — no ${label} command was run in ${session.execs.length} shell invocations`,
      evidence: [],
    };
  }

  // The most recent run is what a reader would understand the claim to be about.
  const latest = prior[prior.length - 1]!;
  if (latest.outcome === 'failed') {
    return {
      claim,
      verdict: 'CONTRADICTED',
      reason: `claimed ${label} passed — the last observed ${label} run failed${latest.exitCode === null ? '' : ` (exit ${latest.exitCode})`}`,
      evidence: [latest],
    };
  }
  if (latest.outcome === 'passed') {
    if (claim.assertion === 'ran') {
      return { claim, verdict: 'VERIFIED', reason: `${label} did run and succeeded`, evidence: [latest] };
    }
    return {
      claim,
      verdict: 'VERIFIED',
      reason: `${label} observed passing via ${latest.basis === 'exit-status' ? 'exit status 0' : 'runner summary'}`,
      evidence: [latest],
    };
  }
  if (claim.assertion === 'ran') {
    return { claim, verdict: 'VERIFIED', reason: `${label} did run; outcome not determinable`, evidence: [latest] };
  }
  return {
    claim,
    verdict: 'UNKNOWN',
    reason: `${label} ran but its outcome is not recoverable from the transcript (output piped or suppressed)`,
    evidence: [latest],
  };
}

/**
 * Derive a report for one session.
 *
 * `claims` is supplied when the session was rebuilt from the evidence store,
 * where utterances are not retained — only the claim sentences extracted at
 * ingest time. That preserves `ADR-025`: claims are *observations* (the agent
 * did say this sentence) and the verdict is still recomputed on read from the
 * stored claim and the stored runs, never read back from storage.
 *
 * The honest consequence: a stored session reflects the extractor as it was at
 * ingest. Improving the extractor changes what a live re-parse sees, not what
 * history recorded — which is the correct behaviour for an audit log.
 */
export function reconcile(session: Session, claims?: readonly Claim[]): SessionReport {
  const runs = observedRuns(session);
  const subjects = claims ?? claimsFromSession(session);
  const findings = subjects.map((claim) => judge(claim, runs, session));
  const activities = new Set<Activity>(runs.map((r) => r.activity));

  const risk: SessionReport['risk'] = findings.some((f) => f.verdict === 'CONTRADICTED')
    ? 'high'
    : findings.some((f) => f.verdict === 'UNSUPPORTED')
      ? 'high'
      : findings.some((f) => f.verdict === 'UNKNOWN')
        ? 'medium'
        : 'low';

  return { session, runs, findings, observedActivities: [...activities], risk };
}

/** Collapse a session's findings to the one badge a reviewer reads first. */
export function badge(report: SessionReport): { verdict: Verdict; text: string } {
  const order: Verdict[] = ['CONTRADICTED', 'UNSUPPORTED', 'UNKNOWN', 'VERIFIED'];
  const total = report.findings.length;
  for (const verdict of order) {
    const hit = report.findings.filter((f) => f.verdict === verdict);
    const first = hit[0];
    if (first === undefined) continue;
    /*
     * `N of M claims`, not `+N more`. The old suffix counted only findings of
     * this same verdict, so a session with one CONTRADICTED and seven UNKNOWN
     * rendered no suffix at all — a reader reasonably infers one finding total.
     * Naming both numbers cannot mislead in either direction.
     */
    const extra = total > 1 ? ` (${hit.length} of ${total} claims)` : '';
    switch (verdict) {
      case 'CONTRADICTED':
        return { verdict, text: `${LABEL[first.claim.activity]} claimed passing, observed failing${extra}` };
      case 'UNSUPPORTED':
        return { verdict, text: `${LABEL[first.claim.activity]} claimed, never observed${extra}` };
      case 'UNKNOWN':
        return { verdict, text: `${LABEL[first.claim.activity]} claim not verifiable${extra}` };
      case 'VERIFIED':
        return { verdict, text: `${LABEL[first.claim.activity]} claimed and observed${extra}` };
    }
  }
  const ran = report.runs.filter((r) => r.activity === 'test');
  if (ran.length > 0) return { verdict: 'VERIFIED', text: 'tests observed, none claimed' };
  return { verdict: 'UNKNOWN', text: 'no execution claims made' };
}

/** Ranking used by every surface. Lower sorts first. */
export const RISK_ORDER: Record<Verdict, number> = { CONTRADICTED: 0, UNSUPPORTED: 1, UNKNOWN: 2, VERIFIED: 3 };

export interface BranchRow {
  /** Display label; qualified with the repository when the set spans several. */
  label: string;
  branch: string;
  cwd: string | undefined;
  reports: SessionReport[];
  verdict: Verdict;
  summary: string;
  execs: number;
  edits: number;
  tokens: number;
  /** True when this row is why the user opened the tool. */
  needsAttention: boolean;
}

/** Git emits coloured branch names when `color.branch` is set; escapes are not identity. */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * The shortest trailing path segments that still tell two repositories apart.
 *
 * `basename` alone is ambiguous — every monorepo has an `app` — and a full path is
 * unreadable and leaks the reviewer's home directory into a shared report. So:
 * one segment when that is unique, more only for the paths that actually collide.
 */
function shortestUniqueLabels(paths: readonly string[]): Map<string, string> {
  const segmentsOf = new Map(paths.map((p) => [p, p.split('/').filter((s) => s !== '')]));
  const labels = new Map<string, string>();

  for (const path of paths) {
    const segments = segmentsOf.get(path) ?? [];
    let depth = 1;
    // Grow the suffix until no other path shares it, or we run out of segments.
    while (depth < segments.length) {
      const candidate = segments.slice(-depth).join('/');
      const collides = paths.some((other) => other !== path && (segmentsOf.get(other) ?? []).slice(-depth).join('/') === candidate);
      if (!collides) break;
      depth += 1;
    }
    labels.set(path, segments.slice(-depth).join('/') || path || 'unknown');
  }

  return labels;
}

/**
 * Collapse sessions into the branch rows both the terminal and the HTML report
 * render. Shared deliberately: two surfaces computing "which branch is worst"
 * independently is a bug waiting to be reported as a contradiction between them.
 */
export function groupBranches(reports: SessionReport[]): BranchRow[] {
  // A branch name is only unique within a repository. `HEAD` and `main` recur
  // across every repo on a machine, so grouping on the name alone merges
  // unrelated work into one row.
  const repos = new Set(reports.map((r) => r.session.cwd ?? ''));
  const qualify = repos.size > 1;
  const repoLabel = shortestUniqueLabels([...repos]);

  const groups = new Map<string, { label: string; reports: SessionReport[] }>();
  for (const report of reports) {
    const branch = stripAnsi(report.session.gitBranch ?? '(no branch)');
    const cwd = report.session.cwd ?? '';
    // Key on the full cwd — `basename` alone merges unrelated repos that share a
    // trailing directory name (`client/app` vs `server/app`). The *label* is the
    // shortest suffix that stays unambiguous, so the common case reads as one word.
    const key = qualify ? `${cwd}\u0000${branch}` : branch;
    const existing = groups.get(key);
    if (existing === undefined) {
      const label = qualify ? `${repoLabel.get(cwd) ?? 'unknown'}/${branch}` : branch;
      groups.set(key, { label, reports: [report] });
    } else {
      existing.reports.push(report);
    }
  }

  const rows: BranchRow[] = [];
  for (const [, { label, reports: group }] of groups) {
    const worst = group
      .map((r) => badge(r))
      .sort((a, b) => RISK_ORDER[a.verdict] - RISK_ORDER[b.verdict])[0]!;
    const first = group[0]!;
    rows.push({
      label,
      branch: first.session.gitBranch ?? '(no branch)',
      cwd: first.session.cwd,
      reports: group,
      verdict: worst.verdict,
      summary: worst.text,
      execs: group.reduce((n, r) => n + r.session.execs.length, 0),
      edits: group.reduce((n, r) => n + r.session.edits.length, 0),
      tokens: group.reduce((n, r) => n + r.session.usage.inputTokens + r.session.usage.outputTokens, 0),
      needsAttention: worst.verdict === 'CONTRADICTED' || worst.verdict === 'UNSUPPORTED',
    });
  }

  return rows.sort((a, b) => RISK_ORDER[a.verdict] - RISK_ORDER[b.verdict] || b.execs - a.execs);
}
