/**
 * Claude Code session transcript reader (ADR-008: transcript-first, PTY fallback later).
 *
 * The schema below was derived empirically from 18 real sessions / 12,972 JSONL
 * records in `~/.claude/projects`, not from documentation. The findings that
 * shape this module, because they are not obvious and they constrain what the
 * product may honestly claim:
 *
 *   - There is no structured exit code. A *failing* Bash tool_result carries
 *     `is_error: true` and its content string begins `Exit code N`. A succeeding
 *     one carries `is_error: false` and no code at all. So exit 0 is inferred,
 *     never read. `exitCode` is `null` when we cannot tell.
 *   - There is no test tool. Tests run through `Bash`, so identifying them is
 *     classification (see `commands.ts`), not lookup.
 *   - A tool_result can mean "the user refused this command". That is a
 *     *non-execution* and must never count as evidence that something ran.
 *   - MCP tools can execute code too (`mcp__*__*_eval` and friends). Those are
 *     recorded as opaque execution capability, which later forces abstention
 *     rather than an accusation.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type ExecOutcome = 'passed' | 'failed' | 'interrupted' | 'denied' | 'unknown';

export interface ExecEvent {
  seq: number;
  toolUseId: string;
  command: string;
  /** The agent's own one-line description of intent, when present. */
  description: string | undefined;
  ts: string | undefined;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outcome: ExecOutcome;
  /** Backgrounded commands never report a terminal result in the transcript. */
  backgrounded: boolean;
}

export interface Utterance {
  seq: number;
  ts: string | undefined;
  text: string;
}

export interface FileEdit {
  seq: number;
  path: string;
  kind: 'write' | 'edit' | 'notebook';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface Session {
  id: string;
  file: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  agentVersion: string | undefined;
  models: string[];
  startedAt: string | undefined;
  endedAt: string | undefined;
  execs: ExecEvent[];
  utterances: Utterance[];
  edits: FileEdit[];
  /**
   * Names of non-Bash tools that can run code (MCP eval, notebook execution).
   * Presence here is the trigger for abstention in `reconcile.ts`.
   */
  opaqueExecutors: string[];
  usage: Usage;
  /** Records the reader could not interpret. Surfaced, never swallowed. */
  unparsedLines: number;
}

const EXIT_CODE = /^\s*(?:Error:\s*)?Exit code (\d+)/;

/**
 * A `tool_result` that is a refusal rather than an execution. Claude Code emits
 * these verbatim when a permission prompt is declined; treating one as an
 * execution would be the exact false accusation Gate A forbids.
 */
const DENIAL = /^(?:The user doesn't want to proceed|The user doesn't want to take this action|Tool use was rejected|User rejected|The user has denied)/i;

/** MCP / builtin tools that execute arbitrary code and hide it from us. */
const OPAQUE_EXECUTOR = /(?:_eval|_exec|_run|_shell|_python|_bash|_terminal|_notebook|_test)$|^NotebookEdit$|^Task$/i;

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  seq: number;
  ts: string | undefined;
}

/**
 * A field read that is checked at runtime. Transcript records are external JSON,
 * so every access goes through here or through an explicit `typeof` guard.
 */
function str(source: unknown, key: string): string | undefined {
  if (source === null || typeof source !== 'object' || !(key in source)) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function num(source: unknown, key: string): number {
  if (source === null || typeof source !== 'object' || !(key in source)) return 0;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : 0;
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = str(block, 'text');
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Decide the outcome of one Bash invocation. This is the single most
 * precision-critical function in the evidence path: everything downstream
 * inherits its honesty. It reports `unknown` rather than guessing.
 */
function classifyResult(isError: boolean, resultText: string, result: unknown): {
  exitCode: number | null;
  outcome: ExecOutcome;
  stdout: string;
  stderr: string;
  backgrounded: boolean;
} {
  const stdout = str(result, 'stdout') ?? '';
  const stderr = str(result, 'stderr') ?? '';
  const interrupted =
    result !== null && typeof result === 'object' && 'interrupted' in result && result.interrupted === true;
  const backgrounded = str(result, 'backgroundTaskId') !== undefined;
  if (DENIAL.test(resultText.trim())) {
    return { exitCode: null, outcome: 'denied', stdout: '', stderr: '', backgrounded };
  }
  if (interrupted) {
    return { exitCode: null, outcome: 'interrupted', stdout, stderr, backgrounded };
  }
  if (backgrounded) {
    // Started, not finished. No terminal state exists to report.
    return { exitCode: null, outcome: 'unknown', stdout, stderr, backgrounded };
  }
  if (isError) {
    const m = EXIT_CODE.exec(resultText);
    return {
      exitCode: m?.[1] !== undefined ? Number(m[1]) : null,
      outcome: 'failed',
      stdout: stdout || resultText,
      stderr,
      backgrounded,
    };
  }
  // Not an error and not interrupted: the tool ran to completion with status 0.
  return { exitCode: 0, outcome: 'passed', stdout: stdout || resultText, stderr, backgrounded };
}

/** Read one Claude Code `.jsonl` transcript into a normalized session. */
export async function readTranscript(file: string): Promise<Session> {
  const session: Session = {
    id: '',
    file,
    cwd: undefined,
    gitBranch: undefined,
    agentVersion: undefined,
    models: [],
    startedAt: undefined,
    endedAt: undefined,
    execs: [],
    utterances: [],
    edits: [],
    opaqueExecutors: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    unparsedLines: 0,
  };
  const models = new Set<string>();
  const opaque = new Set<string>();
  /** tool_use id -> the invocation, so a later tool_result can be joined to it. */
  const pending = new Map<string, ToolUse>();

  // Stream creation can throw (ENOENT if file disappeared, EACCES). The for-await
  // loop can throw on mid-read I/O errors. Both are I/O failures on external data
  // that was valid at discovery time; crashing the process is the wrong response.
  let stream;
  try {
    stream = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  } catch {
    return session;
  }
  let seq = 0;

  try {
  for await (const raw of stream) {
    seq += 1;
    const line = raw.trim();
    if (line.length === 0) continue;

    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      session.unparsedLines += 1;
      continue;
    }

    const sessionId = str(rec, 'sessionId');
    if (sessionId !== undefined && session.id === '') session.id = sessionId;
    session.cwd ??= str(rec, 'cwd');
    const branch = str(rec, 'gitBranch');
    if (branch !== undefined && branch !== '') session.gitBranch = branch;
    session.agentVersion = str(rec, 'version') ?? session.agentVersion;
    const ts = str(rec, 'timestamp');
    if (ts !== undefined) {
      if (session.startedAt === undefined || ts < session.startedAt) session.startedAt = ts;
      if (session.endedAt === undefined || ts > session.endedAt) session.endedAt = ts;
    }
    const recType = str(rec, 'type');

    if (rec === null || typeof rec !== 'object' || !('message' in rec)) continue;
    const msg = rec.message;
    if (msg === null || typeof msg !== 'object') continue;

    const model = str(msg, 'model');
    if (model !== undefined && model !== '<synthetic>') models.add(model);
    if ('usage' in msg) {
      const u = msg.usage;
      session.usage.inputTokens += num(u, 'input_tokens');
      session.usage.outputTokens += num(u, 'output_tokens');
      session.usage.cacheReadTokens += num(u, 'cache_read_input_tokens');
      session.usage.cacheCreationTokens += num(u, 'cache_creation_input_tokens');
    }

    const content = 'content' in msg ? msg.content : undefined;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const blockType = str(block, 'type');

      switch (blockType) {
        case 'text': {
          // Only the assistant's own prose can contain a claim. User text and
          // `thinking` blocks are excluded: thinking is deliberation, not an
          // assertion to the user, and holding an agent to it would be unfair.
          const text = str(block, 'text');
          if (recType === 'assistant' && text !== undefined && text.trim() !== '') {
            session.utterances.push({ seq, ts, text });
          }
          break;
        }
        case 'tool_use': {
          const id = str(block, 'id');
          const name = str(block, 'name') ?? '';
          const rawInput = 'input' in block ? block.input : undefined;
          const input: Record<string, unknown> =
            rawInput !== null && typeof rawInput === 'object' ? { ...rawInput } : {};
          if (id !== undefined) pending.set(id, { name, input, seq, ts });
          if (OPAQUE_EXECUTOR.test(name)) opaque.add(name);

          const filePath = str(input, 'file_path');
          const notebookPath = str(input, 'notebook_path');
          if (name === 'Write' && filePath !== undefined) {
            session.edits.push({ seq, path: filePath, kind: 'write' });
          } else if (name === 'Edit' && filePath !== undefined) {
            session.edits.push({ seq, path: filePath, kind: 'edit' });
          } else if (name === 'NotebookEdit' && notebookPath !== undefined) {
            session.edits.push({ seq, path: notebookPath, kind: 'notebook' });
          }
          break;
        }
        case 'tool_result': {
          const useId = str(block, 'tool_use_id');
          const use = useId === undefined ? undefined : pending.get(useId);
          if (use === undefined || use.name !== 'Bash') break;
          const command = str(use.input, 'command');
          if (command === undefined || command === '') break;
          const resultText = asText('content' in block ? block.content : undefined);
          const isError = 'is_error' in block && block.is_error === true;
          const { exitCode, outcome, stdout, stderr, backgrounded } = classifyResult(
            isError,
            resultText,
            'toolUseResult' in rec ? rec.toolUseResult : undefined,
          );
          session.execs.push({
            seq: use.seq,
            toolUseId: useId ?? '',
            command,
            description: str(use.input, 'description'),
            ts: use.ts,
            stdout,
            stderr,
            exitCode,
            outcome,
            backgrounded,
          });
          break;
        }
        default:
          break;
      }
    }
  }
  } catch {
    // Mid-stream I/O error (file truncated, filesystem error). Return whatever
    // we parsed so far — partial evidence is more useful than a crash.
  }

  session.models = [...models];
  session.opaqueExecutors = [...opaque];
  if (session.id === '') session.id = file;
  session.execs.sort((a, b) => a.seq - b.seq);
  return session;
}
