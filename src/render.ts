/**
 * Terminal rendering.
 *
 * The design constraint from the strategy docs is that the whole decision must
 * fit on one screen and every flag must be explained in one line. So: no
 * dashboards, no tables of metrics, no progress spinners. A verdict, a reason,
 * and the command that justifies it.
 */

import { basename, relative } from 'node:path';
import { badge, type Finding, type SessionReport, type Verdict } from './reconcile.ts';

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

/** Strip ANSI escape sequences. Git can emit coloured branch names via `color.branch`. */
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '');

const paint = (code: string, text: string) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);

const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

const VERDICT_STYLE: Record<Verdict, { code: string; mark: string }> = {
  CONTRADICTED: { code: '1;31', mark: '✗' },
  UNSUPPORTED: { code: '1;33', mark: '⚠' },
  UNKNOWN: { code: '36', mark: '?' },
  VERIFIED: { code: '32', mark: '✓' },
};

/** Width of the longest verdict label, so queue columns line up. */
const TAG_WIDTH = 14;

/** Fixed grouping: the host locale must not decide how a number reads. */
const count = (n: number) => n.toLocaleString('en-US');

const plural = (n: number, noun: string) => `${count(n)} ${noun}${n === 1 ? '' : 's'}`;

export function verdictTag(verdict: Verdict): string {
  const style = VERDICT_STYLE[verdict];
  return paint(style.code, `${style.mark} ${verdict}`);
}

function findingLines(finding: Finding, indent: string): string[] {
  const lines = [`${indent}${verdictTag(finding.verdict)}  ${finding.reason}`];
  lines.push(`${indent}  ${dim('agent said:')} “${finding.claim.sentence}”`);
  for (const run of finding.evidence.slice(0, 2)) {
    const shown = run.command.length > 96 ? `${run.command.slice(0, 93)}…` : run.command;
    lines.push(`${indent}  ${dim('observed:')}   ${shown} ${dim(`→ ${run.outcome} (${run.basis})`)}`);
  }
  return lines;
}

/** Detail view for one session: `land evidence`. */
export function renderSession(report: SessionReport, cwd: string): string {
  const { session } = report;
  const out: string[] = [];
  const where = session.cwd === undefined ? '' : relative(cwd, session.cwd) || '.';
  const b = badge(report);

  out.push(
    `${bold(session.gitBranch ?? '(no branch recorded)')}  ${dim(`${session.id.slice(0, 8)} · ${where} · ${session.models.join(', ') || 'unknown model'}`)}`,
  );
  out.push(`  ${verdictTag(b.verdict)}  ${b.text}`);
  out.push(
    dim(
      `  ${session.execs.length} shell invocations · ${report.runs.length} classified run${report.runs.length === 1 ? '' : 's'} · ` +
        `${session.edits.length} file edits · ${count(session.usage.inputTokens + session.usage.outputTokens)} tokens`,
    ),
  );

  if (report.findings.length === 0) {
    out.push(dim('  no execution claims found in this session'));
  } else {
    out.push('');
    for (const finding of report.findings) out.push(...findingLines(finding, '  '));
  }

  if (session.unparsedLines > 0) {
    out.push(dim(`  note: ${session.unparsedLines} transcript lines could not be parsed`));
  }
  return out.join('\n');
}

const RISK_ORDER: Record<Verdict, number> = { CONTRADICTED: 0, UNSUPPORTED: 1, UNKNOWN: 2, VERIFIED: 3 };

/**
 * The one-screen queue: branches sorted by what deserves attention. This is the
 * surface the strategy docs identify as the product, so it stays a list of
 * decisions, not a report.
 */
export function renderQueue(reports: SessionReport[]): string {
  // A branch name is only unique within a repository. `HEAD` and `main` recur
  // across every repo on a machine, so grouping on the name alone merged
  // unrelated work into one row under `--all`.
  const repos = new Set(reports.map((r) => r.session.cwd ?? ''));
  const qualify = repos.size > 1;

  const byBranch = new Map<string, SessionReport[]>();
  for (const report of reports) {
    const raw = report.session.gitBranch ?? '(no branch)';
    // Strip ANSI: git can emit coloured branch names via `color.branch`.
    const branch = stripAnsi(raw);
    // Use the full cwd as the repo key, not just `basename`, which collides
    // when two repos share a trailing directory name (e.g. `client/app` vs `server/app`).
    const key = qualify
      ? `${relative(process.cwd(), report.session.cwd ?? 'unknown') || basename(report.session.cwd ?? 'unknown')}/${branch}`
      : branch;
    const bucket = byBranch.get(key);
    if (bucket === undefined) byBranch.set(key, [report]);
    else bucket.push(report);
  }

  const rows = [...byBranch.entries()].map(([branch, group]) => {
    const worst = group
      .map((r) => ({ report: r, b: badge(r) }))
      .sort((a, b) => RISK_ORDER[a.b.verdict] - RISK_ORDER[b.b.verdict])[0]!;
    const execs = group.reduce((n, r) => n + r.session.execs.length, 0);
    const edits = group.reduce((n, r) => n + r.session.edits.length, 0);
    const tokens = group.reduce((n, r) => n + r.session.usage.inputTokens + r.session.usage.outputTokens, 0);
    return { branch, sessions: group.length, execs, edits, tokens, ...worst };
  });

  rows.sort((a, b) => RISK_ORDER[a.b.verdict] - RISK_ORDER[b.b.verdict] || b.execs - a.execs);

  // Cap branch labels: an unbounded name pushes verdict text off-screen.
  const maxBranch = Math.min(60, (process.stdout.columns ?? 120) - TAG_WIDTH - 40);
  const width = Math.max(6, ...rows.map((r) => Math.min(r.branch.length, maxBranch)));
  const out: string[] = [];
  for (const row of rows) {
    const style = VERDICT_STYLE[row.b.verdict];
    const tag = paint(style.code, `${style.mark} ${row.b.verdict}`.padEnd(TAG_WIDTH));
    // Truncate, then pad: truncation removes characters that padding would
    // compensate for; reversing the order under-pads every truncated label.
    const label = row.branch.length > maxBranch ? row.branch.slice(0, maxBranch - 1) + '…' : row.branch;
    out.push(`${tag} ${bold(label.padEnd(width))}  ${row.b.text}`);
    out.push(
      dim(
        `${' '.repeat(TAG_WIDTH + 1 + width + 2)}${plural(row.sessions, 'session')}` +
          ` · ${plural(row.execs, 'command')} · ${plural(row.edits, 'edit')} · ${count(row.tokens)} tokens`,
      ),
    );
  }

  const attention = rows.filter((r) => r.b.verdict === 'CONTRADICTED' || r.b.verdict === 'UNSUPPORTED');
  out.push('');
  if (attention.length === 0) {
    out.push(dim('No unsupported execution claims. Nothing here is lying to you about tests.'));
  } else {
    out.push(
      `${bold('Read first:')} ${attention.map((r) => r.branch).join(', ')} ${dim(`(${attention.length} of ${rows.length} branches)`)}`,
    );
  }
  return out.join('\n');
}
