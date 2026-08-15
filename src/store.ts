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
import { claimsFromSession, type Claim, type ClaimActivity } from './claims.ts';
import type { ExecOutcome, FileEdit, Session } from './transcript.ts';

export const SCHEMA_VERSION = 2;
export const GENESIS = '0'.repeat(64);

/** Output is evidence of a run's shape, not an archive of its text. */
const MAX_OUTPUT_BYTES = 8 * 1024;

export interface IngestResult {
  sessionId: string;
  events: number;
  /** No new events: either already stored in full, or the transcript has not grown. */
  skipped: boolean;
  /** New events were added to a session that was already partially stored. */
  appended: boolean;
  redactions: RedactionCount;
  headHash: string;
}

/**
 * A session rebuilt from the store, with the claims recorded at ingest.
 *
 * The claims travel beside the session rather than inside it because they are
 * not part of the transcript shape: `Session.utterances` is the prose a live
 * parse sees, and the store keeps only what was extracted from it.
 */
export interface StoredSession {
  session: Session;
  claims: Claim[];
}

/*
 * Rows come back from SQLite as `unknown`. These are the only readers of that
 * data, and each one narrows explicitly: a stored payload is external input,
 * even though we wrote it, because the file on disk is what we actually trust.
 */

function optText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const OUTCOMES: readonly ExecOutcome[] = ['passed', 'failed', 'interrupted', 'denied', 'unknown'];
function asOutcome(value: unknown): ExecOutcome {
  return OUTCOMES.find((o) => o === value) ?? 'unknown';
}

const EDIT_KINDS: readonly FileEdit['kind'][] = ['write', 'edit', 'notebook'];
function asEditKind(value: unknown): FileEdit['kind'] {
  return EDIT_KINDS.find((k) => k === value) ?? 'edit';
}

const CLAIM_ACTIVITIES: readonly ClaimActivity[] = ['test', 'build', 'typecheck', 'lint'];
function asClaimActivity(value: unknown): ClaimActivity | undefined {
  return CLAIM_ACTIVITIES.find((a) => a === value);
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
  -- Size and mtime of the transcript as ingested. With the path, these let
  -- ingest skip an unchanged file *before* parsing it -- the skip decision
  -- used to be made only after a full parse.
  source_size            INTEGER,
  source_mtime           TEXT,
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
CREATE INDEX IF NOT EXISTS sessions_source ON sessions(source_file);

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
    this.migrate();
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * Bring an older store forward. `CREATE TABLE IF NOT EXISTS` does not add
   * columns to a table that already exists, so a v1 store opened by v2 code
   * would be missing `source_size`/`source_mtime` and every write would fail.
   *
   * Only additive, nullable columns are used, so no data is rewritten — which
   * matters because `events` is append-only by trigger and must never be touched.
   */
  private migrate(): void {
    const columns = new Set(
      this.db
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all('sessions')
        .map((row) => String(row['name'])),
    );
    if (!columns.has('source_size')) this.db.exec('ALTER TABLE sessions ADD COLUMN source_size INTEGER');
    if (!columns.has('source_mtime')) this.db.exec('ALTER TABLE sessions ADD COLUMN source_mtime TEXT');
  }

  close(): void {
    this.db.close();
  }

  /**
   * True when this exact file — same path, size and mtime — is already ingested.
   *
   * This is the skip test `ingest` needs *before* reading a transcript. The
   * session id lives inside the file, so identity previously required a full
   * parse; a repo with 200 sessions paid that cost on every run to discover it
   * had nothing to do. Any edit changes size or mtime, so a modified transcript
   * still gets parsed.
   */
  seenFile(file: string, size: number, mtime: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM sessions WHERE source_file = ? AND source_size = ? AND source_mtime = ?')
        .get(file, size, mtime) !== undefined
    );
  }

  headHash(): string {
    const row = this.db.prepare('SELECT hash FROM events ORDER BY id DESC LIMIT 1').get();
    return row !== undefined && typeof row['hash'] === 'string' ? row['hash'] : GENESIS;
  }

  has(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined;
  }

  /**
   * Highest event `seq` already stored for a session, or -1 when it is new.
   * Used to append only what is new, rather than refusing the whole session.
   */
  private storedThrough(sessionId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS high FROM events WHERE session_id = ?').get(sessionId);
    const high = row?.['high'];
    return typeof high === 'number' ? high : -1;
  }

  /**
   * Append a parsed session, or the part of it that is not yet recorded.
   *
   * Agents append to a transcript while they work, so a session ingested
   * mid-flight is a *prefix* of the real one. Treating a known session id as a
   * no-op silently discarded every later event: a store ingested during a run
   * would exonerate an agent that a live parse convicts, because the lie
   * arrived after the snapshot. Verified on a synthetic growing session where
   * the store held 3 events and missed a CONTRADICTED lint claim entirely.
   *
   * Appending is the correct reading of an append-only chain: a longer session
   * is more observations, not rewritten ones. Events already stored are never
   * touched — only `seq` values beyond the recorded high-water mark are added,
   * so the existing chain and every hash in it stay byte-identical.
   */
  ingest(session: Session, source?: { size: number; mtime: string }): IngestResult {
    const known = this.has(session.id);
    const through = known ? this.storedThrough(session.id) : -1;

    const redactions: RedactionCount = {};
    const insertEvent = this.db.prepare(
      'INSERT INTO events(session_id, seq, ts, kind, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    let prev = this.headHash();
    let count = 0;

    const append = (seq: number, ts: string | undefined, kind: string, payload: Record<string, unknown>) => {
      // The high-water mark is what keeps this idempotent. Re-ingesting a
      // transcript that has grown appends only its new tail.
      if (seq <= through) return;
      const hash = linkHash(prev, payload);
      insertEvent.run(session.id, seq, ts ?? null, kind, canonical(payload), prev, hash);
      prev = hash;
      count += 1;
    };

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          /*
           * The session row is metadata, not evidence: token totals, end time
           * and file size all move as a session continues, so re-ingesting a
           * grown transcript must refresh them. Only `events` is append-only
           * (enforced by trigger); rewriting a token count cannot alter history.
           * `started_at` and `ingested_at` keep their original values — the
           * first sighting is itself a fact worth preserving.
           */
          `INSERT INTO sessions(id, source_file, source_size, source_mtime, cwd, git_branch, agent_version,
             models, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens,
             cache_creation_tokens, opaque_executors, unparsed_lines, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source_size = excluded.source_size,
             source_mtime = excluded.source_mtime,
             git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
             agent_version = COALESCE(excluded.agent_version, sessions.agent_version),
             models = excluded.models,
             ended_at = excluded.ended_at,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cache_read_tokens = excluded.cache_read_tokens,
             cache_creation_tokens = excluded.cache_creation_tokens,
             opaque_executors = excluded.opaque_executors,
             unparsed_lines = excluded.unparsed_lines`,
        )
        .run(
          session.id,
          session.file,
          source?.size ?? null,
          source?.mtime ?? null,
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

    // `skipped` now means "contributed no new events", which is true both for a
    // session already stored in full and for one whose transcript has not grown.
    return { sessionId: session.id, events: count, skipped: count === 0, appended: known && count > 0, redactions, headHash: prev };
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

  /**
   * Rebuild sessions from stored events, with the claims recorded at ingest.
   *
   * This is what makes the chain load-bearing rather than write-only: `queue`,
   * `evidence` and `ui` can read a store instead of re-parsing transcripts,
   * which is the only way to see a session that ran on another machine or a
   * transcript the agent has since rotated away.
   *
   * `utterances` comes back empty — prose is deliberately not retained, only
   * the claim sentences extracted from it. Callers pass the returned claims to
   * `reconcile` so verdicts are still derived on read, never read back.
   */
  read(filter: { repo?: string; branch?: string; session?: string } = {}): StoredSession[] {
    const where: string[] = [];
    const params: Array<string> = [];
    if (filter.repo !== undefined) {
      where.push('cwd = ?');
      params.push(filter.repo);
    }
    if (filter.branch !== undefined) {
      where.push('git_branch = ?');
      params.push(filter.branch);
    }
    if (filter.session !== undefined) {
      where.push('id LIKE ?');
      params.push(`${filter.session}%`);
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;

    const rows = this.db.prepare(`SELECT * FROM sessions${clause} ORDER BY started_at`).all(...params);
    const eventsFor = this.db.prepare('SELECT seq, ts, kind, payload FROM events WHERE session_id = ? ORDER BY id');

    return rows.map((row) => {
      const id = String(row['id']);
      const session: Session = {
        id,
        file: String(row['source_file']),
        cwd: optText(row['cwd']),
        gitBranch: optText(row['git_branch']),
        agentVersion: optText(row['agent_version']),
        models: parseList(row['models']),
        startedAt: optText(row['started_at']),
        endedAt: optText(row['ended_at']),
        execs: [],
        utterances: [],
        edits: [],
        opaqueExecutors: parseList(row['opaque_executors']),
        usage: {
          inputTokens: Number(row['input_tokens'] ?? 0),
          outputTokens: Number(row['output_tokens'] ?? 0),
          cacheReadTokens: Number(row['cache_read_tokens'] ?? 0),
          cacheCreationTokens: Number(row['cache_creation_tokens'] ?? 0),
        },
        unparsedLines: Number(row['unparsed_lines'] ?? 0),
      };
      const claims: Claim[] = [];

      for (const event of eventsFor.all(id)) {
        const seq = Number(event['seq']);
        const ts = optText(event['ts']);
        const payload: unknown = JSON.parse(String(event['payload']));
        if (payload === null || typeof payload !== 'object') continue;
        const p = payload as Record<string, unknown>;

        switch (String(event['kind'])) {
          case 'exec':
            session.execs.push({
              seq,
              ts,
              toolUseId: String(p['toolUseId'] ?? ''),
              command: String(p['command'] ?? ''),
              description: optText(p['description']),
              stdout: String(p['stdout'] ?? ''),
              stderr: String(p['stderr'] ?? ''),
              exitCode: typeof p['exitCode'] === 'number' ? p['exitCode'] : null,
              outcome: asOutcome(p['outcome']),
              backgrounded: p['backgrounded'] === true,
            });
            break;
          case 'edit':
            session.edits.push({ seq, path: String(p['path'] ?? ''), kind: asEditKind(p['kind']) });
            break;
          case 'claim': {
            const activity = asClaimActivity(p['activity']);
            if (activity !== undefined) {
              claims.push({
                seq,
                ts,
                activity,
                assertion: p['assertion'] === 'ran' ? 'ran' : 'pass',
                sentence: String(p['sentence'] ?? ''),
              });
            }
            break;
          }
          // `run` events are re-derived from `execs` by `observedRuns`, so they
          // are not replayed here. They stay in the chain as the record of what
          // the classifier concluded at ingest, which a later reader can diff
          // against a fresh derivation to detect classifier drift.
          default:
            break;
        }
      }

      session.execs.sort((a, b) => a.seq - b.seq);
      return { session, claims };
    });
  }
}
