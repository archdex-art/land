/**
 * CI surface (F-032).
 *
 * `land ci` is the same reconciliation the terminal shows, rendered in the three
 * dialects a CI runner understands: workflow log commands, a job summary written
 * to a file, and step outputs written to another file. All three are plain text
 * protocols, so this module has no dependencies — `@actions/core` exists to hide
 * exactly this much string formatting, and it would be the first runtime
 * dependency in the project (`ADR-022`).
 *
 * The gate is a *policy*, not a fixed rule. A team adopting this cannot start by
 * failing builds on `UNKNOWN` — most sessions are legitimately unverifiable — so
 * the default fails only on a contradiction, which is the one verdict that means
 * an agent's summary was actually wrong.
 */

import { groupBranches, RISK_ORDER, type SessionReport, type Verdict } from './reconcile.ts';

/**
 * Which verdicts fail the build. Ordered from strictest to most permissive, and
 * expressed as the *worst tolerated* verdict rather than a set, because a policy
 * that fails on `CONTRADICTED` but tolerates `UNSUPPORTED` is incoherent: an
 * unsupported claim is a stronger accusation, not a weaker one.
 */
export type Policy = 'contradicted' | 'unsupported' | 'unknown' | 'never';

const POLICY_FAILS: Record<Policy, readonly Verdict[]> = {
  contradicted: ['CONTRADICTED'],
  unsupported: ['CONTRADICTED', 'UNSUPPORTED'],
  unknown: ['CONTRADICTED', 'UNSUPPORTED', 'UNKNOWN'],
  never: [],
};

export function isPolicy(value: string): value is Policy {
  return value === 'contradicted' || value === 'unsupported' || value === 'unknown' || value === 'never';
}

export interface CiResult {
  /** Branch rows that violate the policy. */
  violations: Array<{ label: string; verdict: Verdict; summary: string }>;
  counts: Record<Verdict, number>;
  branches: number;
  sessions: number;
  /** Chain state when a store was read; `undefined` when parsing transcripts. */
  chain: { ok: boolean; events: number; brokenAt?: number } | undefined;
}

export function evaluate(reports: SessionReport[], policy: Policy): Omit<CiResult, 'chain'> {
  const rows = groupBranches(reports);
  const fails = POLICY_FAILS[policy];
  const findings = reports.flatMap((r) => r.findings);

  return {
    violations: rows
      .filter((row) => fails.includes(row.verdict))
      .map((row) => ({ label: row.label, verdict: row.verdict, summary: row.summary })),
    counts: {
      CONTRADICTED: findings.filter((f) => f.verdict === 'CONTRADICTED').length,
      UNSUPPORTED: findings.filter((f) => f.verdict === 'UNSUPPORTED').length,
      UNKNOWN: findings.filter((f) => f.verdict === 'UNKNOWN').length,
      VERIFIED: findings.filter((f) => f.verdict === 'VERIFIED').length,
    },
    branches: rows.length,
    sessions: reports.length,
  };
}

/**
 * Escape a workflow-command property value.
 *
 * GitHub delimits these with `,` and `::`, so an unescaped agent claim
 * containing either would truncate the annotation or inject a second command.
 * The percent-encoding set is fixed by GitHub's own toolkit.
 */
function escapeProperty(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

/**
 * Escape a workflow-command message body.
 *
 * Newlines and `%` follow GitHub's own toolkit. The extra rule is `::`: the
 * toolkit leaves it alone because a body is terminal in GitHub's grammar, but a
 * branch name arrives from transcript JSON — untrusted external input — and
 * `main::error title=forged::owned` in a log stream is at best confusing to
 * anyone grepping it and at worst parsed as a second command. Only the doubled
 * form is encoded, so ordinary single colons stay readable.
 */
function escapeData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/::/g, '%3A%3A');
}

/**
 * Workflow log commands. GitHub turns these into annotations on the run; on any
 * other runner they are harmless log lines, which is why this is safe to emit
 * unconditionally rather than sniffing for `GITHUB_ACTIONS`.
 */
export function annotations(result: CiResult): string[] {
  const lines: string[] = [];

  for (const v of result.violations) {
    const level = v.verdict === 'UNKNOWN' ? 'warning' : 'error';
    lines.push(
      `::${level} title=${escapeProperty(`land: ${v.verdict} on ${v.label}`)}::${escapeData(
        `${v.label} — ${v.summary}`,
      )}`,
    );
  }

  if (result.chain !== undefined && !result.chain.ok) {
    lines.push(
      `::error title=land%3A evidence chain broken::${escapeData(
        `The evidence chain diverges at event ${result.chain.brokenAt ?? 0}. Nothing after that point can be verified.`,
      )}`,
    );
  }

  return lines;
}

/**
 * Job summary in GitHub-flavoured Markdown.
 *
 * Deliberately not a copy of the HTML report: a summary that has to be scrolled
 * is not a summary. It answers "did this pass, and if not which branch", and
 * points at the uploaded report for everything else.
 */
export function summary(result: CiResult, policy: Policy, reportPath: string | undefined): string {
  const { counts } = result;
  const out: string[] = [];
  const passed = result.violations.length === 0 && result.chain?.ok !== false;

  const n = result.violations.length;
  out.push(
    passed
      ? '## ✓ land — every execution claim holds up'
      : `## ✕ land — ${n} branch${n === 1 ? '' : 'es'} ${n === 1 ? 'needs' : 'need'} reading`,
  );
  out.push('');

  if (result.chain !== undefined) {
    out.push(
      result.chain.ok
        ? `Evidence chain intact — ${result.chain.events.toLocaleString('en-US')} events verified.`
        : `**Evidence chain broken at event ${result.chain.brokenAt ?? 0}.** Nothing after that point can be verified.`,
    );
    out.push('');
  }

  out.push('| Verdict | Claims |');
  out.push('|---|---:|');
  out.push(`| ✕ Contradicted | ${counts.CONTRADICTED} |`);
  out.push(`| ! Unsupported | ${counts.UNSUPPORTED} |`);
  out.push(`| – Not determinable | ${counts.UNKNOWN} |`);
  out.push(`| ✓ Verified | ${counts.VERIFIED} |`);
  out.push('');
  out.push(
    `Across **${result.branches}** branch${result.branches === 1 ? '' : 'es'} ` +
      `in **${result.sessions}** session${result.sessions === 1 ? '' : 's'}. Gate: \`--fail-on ${policy}\`.`,
  );

  if (result.violations.length > 0) {
    out.push('');
    out.push('### Read these first');
    out.push('');
    for (const v of [...result.violations].sort((a, b) => RISK_ORDER[a.verdict] - RISK_ORDER[b.verdict])) {
      out.push(`- **${v.label}** — ${v.verdict}: ${v.summary}`);
    }
  }

  if (reportPath !== undefined) {
    out.push('');
    out.push(`Full evidence report written to \`${reportPath}\` — upload it as an artifact to keep the proof.`);
  }

  if (passed) {
    out.push('');
    out.push(
      '_Nothing here is overstating its work: every claim is either backed by an observed run or explicitly marked unverifiable._',
    );
  }

  return `${out.join('\n')}\n`;
}

/**
 * Step outputs, so a later step can branch without re-parsing our stdout.
 *
 * Uses the heredoc form for every value. Even `verdict` goes through it: the
 * single-line `name=value` form is a shell-injection shaped hole the moment a
 * value ever contains a newline, and "this one cannot" is a claim that rots.
 */
export function outputs(result: CiResult): string {
  const worst = result.violations[0]?.verdict ?? 'VERIFIED';
  const pairs: Array<[string, string]> = [
    ['passed', String(result.violations.length === 0 && result.chain?.ok !== false)],
    ['worst-verdict', worst],
    ['violations', String(result.violations.length)],
    ['branches', String(result.branches)],
    ['contradicted', String(result.counts.CONTRADICTED)],
    ['unsupported', String(result.counts.UNSUPPORTED)],
    ['unknown', String(result.counts.UNKNOWN)],
    ['verified', String(result.counts.VERIFIED)],
    ['chain-ok', String(result.chain?.ok !== false)],
  ];

  return pairs
    .map(([key, value]) => {
      const delim = `land_${key}_eof`;
      return `${key}<<${delim}\n${value}\n${delim}`;
    })
    .join('\n')
    .concat('\n');
}

/** Human-readable stdout for a runner's plain log, or a developer running it locally. */
export function plain(result: CiResult, policy: Policy): string {
  const out: string[] = [];
  const { counts } = result;
  out.push(
    `land ci · ${result.branches} branch${result.branches === 1 ? '' : 'es'} · ` +
      `${counts.CONTRADICTED} contradicted · ${counts.UNSUPPORTED} unsupported · ` +
      `${counts.UNKNOWN} not determinable · ${counts.VERIFIED} verified`,
  );
  if (result.chain !== undefined) {
    out.push(
      result.chain.ok
        ? `chain intact: ${result.chain.events} events`
        : `chain BROKEN at event ${result.chain.brokenAt ?? 0}`,
    );
  }
  for (const v of result.violations) out.push(`  ${v.verdict}  ${v.label} — ${v.summary}`);
  out.push(
    result.violations.length === 0
      ? `gate passed (--fail-on ${policy})`
      : `gate failed: ${result.violations.length} violation${result.violations.length === 1 ? '' : 's'} (--fail-on ${policy})`,
  );
  return `${out.join('\n')}\n`;
}
