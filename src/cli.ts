#!/usr/bin/env node
/**
 * `land` — fan-in console for parallel AI coding agents.
 *
 * Scope of this binary is deliberately one question: for each agent branch, did
 * the agent actually run what it said it ran? Conflict prediction (Primitive B)
 * is a separate milestone and is not stubbed here — nothing in this CLI pretends
 * to answer it.
 *
 * Every command supports `--json` (ADR-018). The JSON shape is the contract other
 * tools integrate against, so it is stable and versioned.
 */

import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { allTranscripts, transcriptsFor } from './discover.ts';
import { readTranscript, type Session } from './transcript.ts';
import { badge, reconcile, type SessionReport } from './reconcile.ts';
import { renderQueue, renderSession } from './render.ts';
import { renderReport } from './report.ts';
import { EvidenceStore } from './store.ts';

const OUTPUT_VERSION = 1;

const USAGE = `land — prove what your coding agents actually ran

usage
  land queue    [--repo <path>] [--branch <name>] [--json]
      Risk-ranked view of every agent branch. Start here.

  land evidence [--repo <path>] [--branch <name>] [--session <id>] [--json]
      Per-session detail: every claim, its verdict, and the command behind it.

  land ui       [--repo <path>] [--branch <name>] [--out <file>] [--no-open]
      Write a self-contained HTML report and open it. One file, no server,
      no network requests — send it to a reviewer as proof.

  land ingest   [--repo <path>] [--all] [--store <path>] [--json]
      Append sessions to the hash-chained evidence store.

  land verify   [--store <path>] [--json]
      Recompute the evidence chain and report the first divergence.

options
  --repo <path>     repository to analyse (default: cwd)
  --branch <name>   restrict to one git branch
  --session <id>    restrict to one session id (prefix match)
  --store <path>    evidence database (default: <repo>/.land/evidence.db)
  --all             every transcript on this machine, not just this repo
  --out <file>      where to write the HTML report (default: a temp file)
  --no-open         write the report but do not launch a browser
  --json            machine-readable output
  --limit <n>       max sessions to read (default 200)

verdicts
  ✓ VERIFIED      claim backed by an observed run that succeeded
  ✗ CONTRADICTED  agent claimed success; the observed run failed
  ⚠ UNSUPPORTED   agent claimed it; no such command was ever run
  ? UNKNOWN       not determinable — reported, never guessed
`;

interface Options {
  repo: string;
  branch: string | undefined;
  session: string | undefined;
  store: string;
  all: boolean;
  json: boolean;
  limit: number;
  out: string | undefined;
  open: boolean;
}

function parse(argv: string[]): { command: string; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      branch: { type: 'string' },
      session: { type: 'string' },
      store: { type: 'string' },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      // Declared literally: this Node build does not honour `allowNegative`
      // for `--no-<name>`, and a flag that silently fails is worse than a plain one.
      'no-open': { type: 'boolean', default: false },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const repo = resolve(values.repo ?? process.cwd());
  return {
    command: values.help === true ? 'help' : (positionals[0] ?? 'help'),
    options: {
      repo,
      branch: values.branch,
      session: values.session,
      store: values.store === undefined ? join(repo, '.land', 'evidence.db') : resolve(values.store),
      all: values.all === true,
      json: values.json === true,
      limit: values.limit === undefined ? 200 : Number(values.limit),
      out: values.out === undefined ? undefined : resolve(values.out),
      open: values['no-open'] !== true,
    },
  };
}

/**
 * Read and reconcile the sessions in scope. Transcript reads happen in parallel
 * because they are IO-bound and independent; a repo with 200 sessions is
 * otherwise dominated by sequential file reads.
 */
async function load(options: Options): Promise<SessionReport[]> {
  const files = options.all ? allTranscripts() : transcriptsFor(options.repo);
  const sessions = await Promise.all(
    files.slice(0, options.limit).map(async (file) => {
      try {
        return await readTranscript(file);
      } catch (error) {
        process.stderr.write(`land: skipping ${file}: ${(error as Error).message}\n`);
        return undefined;
      }
    }),
  );

  const inScope = sessions.filter((s): s is Session => {
    if (s === undefined) return false;
    // The recorded cwd is authoritative; the project-directory name is lossy.
    if (!options.all && s.cwd !== undefined && !s.cwd.startsWith(options.repo)) return false;
    if (options.branch !== undefined && s.gitBranch !== options.branch) return false;
    if (options.session !== undefined && !s.id.startsWith(options.session)) return false;
    return s.execs.length > 0 || s.utterances.length > 0;
  });

  return inScope.map(reconcile).sort((a, b) => (a.session.startedAt ?? '').localeCompare(b.session.startedAt ?? ''));
}

function emptyMessage(options: Options): string {
  return options.all
    ? 'land: no agent transcripts found. Set LAND_TRANSCRIPT_ROOT if your agent stores them elsewhere.'
    : `land: no agent sessions recorded for ${options.repo}. Try --all to see every session on this machine.`;
}

async function cmdQueue(options: Options): Promise<number> {
  const reports = await load(options);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: OUTPUT_VERSION,
          repo: options.repo,
          branches: reports.map((r) => ({
            session: r.session.id,
            branch: r.session.gitBranch,
            badge: badge(r),
            risk: r.risk,
            commands: r.session.execs.length,
            edits: r.session.edits.length,
            tokens: r.session.usage.inputTokens + r.session.usage.outputTokens,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (reports.length === 0) {
    process.stdout.write(`${emptyMessage(options)}\n`);
    return 0;
  }
  process.stdout.write(`${renderQueue(reports)}\n`);
  return reports.some((r) => badge(r).verdict === 'CONTRADICTED' || badge(r).verdict === 'UNSUPPORTED') ? 1 : 0;
}

async function cmdEvidence(options: Options): Promise<number> {
  const reports = await load(options);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: OUTPUT_VERSION,
          repo: options.repo,
          sessions: reports.map((r) => ({
            id: r.session.id,
            branch: r.session.gitBranch,
            cwd: r.session.cwd,
            models: r.session.models,
            startedAt: r.session.startedAt,
            endedAt: r.session.endedAt,
            agentVersion: r.session.agentVersion,
            opaqueExecutors: r.session.opaqueExecutors,
            usage: r.session.usage,
            badge: badge(r),
            risk: r.risk,
            observedActivities: r.observedActivities,
            runs: r.runs,
            findings: r.findings.map((f) => ({
              verdict: f.verdict,
              reason: f.reason,
              activity: f.claim.activity,
              assertion: f.claim.assertion,
              sentence: f.claim.sentence,
              evidence: f.evidence,
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (reports.length === 0) {
    process.stdout.write(`${emptyMessage(options)}\n`);
    return 0;
  }
  process.stdout.write(`${reports.map((r) => renderSession(r, options.repo)).join('\n\n')}\n`);
  return reports.some((r) => badge(r).verdict === 'CONTRADICTED') ? 1 : 0;
}

async function cmdIngest(options: Options): Promise<number> {
  const files = options.all ? allTranscripts() : transcriptsFor(options.repo);
  const store = new EvidenceStore(options.store);
  const results: Array<{ file: string; sessionId: string; events: number; skipped: boolean }> = [];
  const redactions: Record<string, number> = {};
  try {
    for (const file of files.slice(0, options.limit)) {
      const session = await readTranscript(file);
      if (!options.all && session.cwd !== undefined && !session.cwd.startsWith(options.repo)) continue;
      const result = store.ingest(session);
      for (const [kind, n] of Object.entries(result.redactions)) redactions[kind] = (redactions[kind] ?? 0) + n;
      results.push({ file, sessionId: result.sessionId, events: result.events, skipped: result.skipped });
    }
    const head = store.headHash();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ version: OUTPUT_VERSION, store: options.store, head, redactions, sessions: results }, null, 2)}\n`);
    } else {
      const added = results.filter((r) => !r.skipped);
      const events = added.reduce((n, r) => n + r.events, 0);
      process.stdout.write(
        `ingested ${added.length} new session${added.length === 1 ? '' : 's'} (${events} events), ` +
          `${results.length - added.length} already present\n` +
          `redactions: ${Object.keys(redactions).length === 0 ? 'none' : Object.entries(redactions).map(([k, v]) => `${k}×${v}`).join(', ')}\n` +
          `store: ${options.store}\nhead: ${head.slice(0, 16)}…\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Open a file with the platform handler. Deliberately not a dependency: the
 * whole command is three platform strings, and `open`/`xdg-open`/`start` is the
 * entirety of what any `open` package does.
 */
function launch(path: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [path]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', path]]
        : ['xdg-open', [path]];
  const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    process.stderr.write(`land: could not open a browser; the report is at ${path}\n`);
  });
  child.unref();
}

async function cmdUi(options: Options): Promise<number> {
  const reports = await load(options);
  const out = options.out ?? join(tmpdir(), `land-${Date.now()}.html`);
  const store = existsSync(options.store) ? new EvidenceStore(options.store) : undefined;
  const meta = {
    repo: options.all ? 'all repositories on this machine' : options.repo,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z',
    chainHead: store?.headHash(),
    version: OUTPUT_VERSION === 1 ? '0.1.0' : String(OUTPUT_VERSION),
  };
  store?.close();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(reports, meta), 'utf8');

  const attention = reports.filter((r) => {
    const v = badge(r).verdict;
    return v === 'CONTRADICTED' || v === 'UNSUPPORTED';
  }).length;

  process.stdout.write(
    `report: ${out}\n${reports.length} session${reports.length === 1 ? '' : 's'}` +
      `${attention === 0 ? ', nothing needs attention' : `, ${attention} needing attention`}\n`,
  );
  if (options.open) launch(out);
  return attention > 0 ? 1 : 0;
}

function cmdVerify(options: Options): number {
  const store = new EvidenceStore(options.store);
  try {
    const result = store.verify();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ version: OUTPUT_VERSION, store: options.store, ...result }, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`chain intact: ${result.events} events\nhead: ${result.head}\n`);
    } else {
      process.stdout.write(
        `chain BROKEN at event ${result.brokenAt}\n  expected ${result.expected}\n  found    ${result.found}\n` +
          'Events after this point cannot be verified.\n',
      );
    }
    return result.ok ? 0 : 2;
  } finally {
    store.close();
  }
}

async function main(): Promise<number> {
  // A mistyped flag is a user error, not a crash: `parseArgs` throws, and an
  // unhandled throw prints a Node stack trace at someone who wanted `--help`.
  let parsed: { command: string; options: Options };
  try {
    parsed = parse(process.argv.slice(2));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('. To specify')[0] : String(error);
    process.stderr.write(`land: ${detail}\n\n${USAGE}`);
    return 64;
  }

  const { command, options } = parsed;
  switch (command) {
    case 'queue':
      return cmdQueue(options);
    case 'evidence':
      return cmdEvidence(options);
    case 'ui':
    case 'report':
      return cmdUi(options);
    case 'ingest':
      return cmdIngest(options);
    case 'verify':
      return cmdVerify(options);
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`land: unknown command '${command}'\n\n${USAGE}`);
      return 64;
  }
}

// `process.exit` discards buffered writes when stdout is a pipe, which silently
// truncates `--json` output for any consumer. Set the code and let Node drain.
process.exitCode = await main();
