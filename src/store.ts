/**
 * Hash-chained evidence store (ADR-005, ADR-011, ADR-017).
 *
 * Design notes worth keeping:
 *
 *   - Only *observations* are chained. Verdicts are derived data and are
 *     recomputed on read, so they are not stored and cannot drift from the
 *     evidence they describe. Tamper-evidence belongs on the source, not on an
 *     opinion about the source.
 *   - Append-only is enforced by SQLite triggers, not by convention. A store
 *     that merely intends to be append-only is not evidence.
 *   - Every text field passes through `redact` on the way in. There is no code
 *     path that writes raw command output.
 *   - `node:sqlite` is used rather than a native driver: zero install, zero
 *     build step, and it ships with the runtime the project already requires.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeCounts, redact, redactAndTruncate, type RedactionCount } from './redact.ts';
import { observedRuns } from './reconcile.ts';
import { claimsFromSession } from './claims.ts';
import type { Session } from './transcript.ts';

export const SCHEMA_VERSION = 1;
export const GENESIS = '0'.repeat(64);

/** Output is evidence of a run's shape, not an archive of its text. */
const MAX_OUTPUT_BYTES = 8 * 1024;

export interface IngestResult {
  sessionId: string;
  events: number;
  skipped: boolean;
  redactions: RedactionCount;
  headHash: string;
}

/**
 * Deterministic JSON for hashing: keys sorted at every level. Without this the
 * chain would depend on property insertion order and verification would fail on
 * a round-trip through any other implementation.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function linkHash(prev: string, payload: unknown): string {
  return createHash('sha256').update(prev).update('\n').update(canonical(payload)).digest('hex');
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                     TEXT PRIMARY KEY,
  source_file            TEXT NOT NULL,
  cwd                    TEXT,
  git_branch             TEXT,
  agent_version          TEXT,
  models                 TEXT NOT NULL,
  started_at             TEXT,
  ended_at               TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  opaque_executors       TEXT NOT NULL DEFAULT '[]',
  unparsed_lines         INTEGER NOT NULL DEFAULT 0,
  ingested_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq        INTEGER NOT NULL,
  ts         TEXT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS sessions_branch ON sessions(git_branch);

-- Append-only, enforced. An evidence log that can be edited is not evidence.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

export class EvidenceStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(DDL);
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  headHash(): string {
    const row = this.db.prepare('SELECT hash FROM events ORDER BY id DESC LIMIT 1').get();
    return row !== undefined && typeof row['hash'] === 'string' ? row['hash'] : GENESIS;
  }

  has(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
  }

  /**
   * Append a parsed session. Re-ingesting an existing session is a no-op rather
   * than an update: the chain forbids rewriting history, so a changed transcript
   * must be recorded as a new session id or not at all.
   */
  ingest(session: Session): IngestResult {
    if (this.has(session.id)) {
      return { sessionId: session.id, events: 0, skipped: true, redactions: {}, headHash: this.headHash() };
    }

    const redactions: RedactionCount = {};
    const insertEvent = this.db.prepare(
      'INSERT INTO events(session_id, seq, ts, kind, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    let prev = this.headHash();
    let count = 0;

    const append = (seq: number, ts: string | undefined, kind: string, payload: Record<string, unknown>) => {
      const hash = linkHash(prev, payload);
      insertEvent.run(session.id, seq, ts ?? null, kind, canonical(payload), prev, hash);
      prev = hash;
      count += 1;
    };

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO sessions(id, source_file, cwd, git_branch, agent_version, models, started_at, ended_at,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, opaque_executors,
             unparsed_lines, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.file,
          session.cwd ?? null,
          session.gitBranch ?? null,
          session.agentVersion ?? null,
          JSON.stringify(session.models),
          session.startedAt ?? null,
          session.endedAt ?? null,
          session.usage.inputTokens,
          session.usage.outputTokens,
          session.usage.cacheReadTokens,
          session.usage.cacheCreationTokens,
          JSON.stringify(session.opaqueExecutors),
          session.unparsedLines,
          new Date().toISOString(),
        );

      for (const exec of session.execs) {
        const command = redact(exec.command);
        const stdout = redactAndTruncate(exec.stdout, MAX_OUTPUT_BYTES);
        const stderr = redactAndTruncate(exec.stderr, MAX_OUTPUT_BYTES);
        mergeCounts(redactions, command.counts);
        mergeCounts(redactions, stdout.counts);
        mergeCounts(redactions, stderr.counts);
        append(exec.seq, exec.ts, 'exec', {
          toolUseId: exec.toolUseId,
          command: command.text,
          description: exec.description === undefined ? null : redact(exec.description).text,
          exitCode: exec.exitCode,
          outcome: exec.outcome,
          backgrounded: exec.backgrounded,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      }

      for (const edit of session.edits) {
        append(edit.seq, undefined, 'edit', { path: edit.path, kind: edit.kind });
      }

      for (const claim of claimsFromSession(session)) {
        const sentence = redact(claim.sentence);
        mergeCounts(redactions, sentence.counts);
        append(claim.seq, claim.ts, 'claim', {
          activity: claim.activity,
          assertion: claim.assertion,
          sentence: sentence.text,
        });
      }

      for (const run of observedRuns(session)) {
        append(run.seq, run.ts, 'run', {
          activity: run.activity,
          outcome: run.outcome,
          basis: run.basis,
          exitCode: run.exitCode,
          command: redact(run.command).text,
        });
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { sessionId: session.id, events: count, skipped: false, redactions, headHash: prev };
  }

  /**
   * Recompute the chain. Returns the first divergence, which is the only
   * information a verifier can honestly give: everything after a break is
   * unverifiable, not necessarily wrong.
   */
  verify(): { ok: true; events: number; head: string } | { ok: false; brokenAt: number; expected: string; found: string } {
    const rows = this.db.prepare('SELECT id, payload, prev_hash, hash FROM events ORDER BY id').all();
    let prev = GENESIS;
    for (const row of rows) {
      const id = Number(row['id']);
      const payload = String(row['payload']);
      if (String(row['prev_hash']) !== prev) {
        return { ok: false, brokenAt: id, expected: prev, found: String(row['prev_hash']) };
      }
      const expected = createHash('sha256').update(prev).update('\n').update(payload).digest('hex');
      if (expected !== String(row['hash'])) {
        return { ok: false, brokenAt: id, expected, found: String(row['hash']) };
      }
      prev = expected;
    }
    return { ok: true, events: rows.length, head: prev };
  }
}
