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
import { join, resolve } from 'node:path';
import { allTranscripts, transcriptsFor } from './discover.ts';
import { readTranscript, type Session } from './transcript.ts';
import { badge, reconcile, type SessionReport } from './reconcile.ts';
import { renderQueue, renderSession } from './render.ts';
import { EvidenceStore } from './store.ts';

const OUTPUT_VERSION = 1;

const USAGE = `land — prove what your coding agents actually ran

usage
  land queue    [--repo <path>] [--branch <name>] [--json]
      Risk-ranked view of every agent branch. Start here.

  land evidence [--repo <path>] [--branch <name>] [--session <id>] [--json]
      Per-session detail: every claim, its verdict, and the command behind it.

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

const { command, options } = parse(process.argv.slice(2));
let code = 0;
switch (command) {
  case 'queue':
    code = await cmdQueue(options);
    break;
  case 'evidence':
    code = await cmdEvidence(options);
    break;
  case 'ingest':
    code = await cmdIngest(options);
    break;
  case 'verify':
    code = cmdVerify(options);
    break;
  case 'help':
    process.stdout.write(USAGE);
    break;
  default:
    process.stderr.write(`land: unknown command '${command}'\n\n${USAGE}`);
    code = 64;
}
// `process.exit` discards buffered writes when stdout is a pipe, which silently
// truncates `--json` output for any consumer. Set the code and let Node drain.
process.exitCode = code;
