/**
 * Synthetic transcripts.
 *
 * The real corpus in `~/.claude/projects` proves the detector does not cry wolf,
 * but it contains no agent that lied, so it cannot prove the detector fires.
 * These fixtures are the negative controls: each one encodes exactly one
 * behaviour we assert on, in the schema the real files use.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ExecSpec {
  command: string;
  stdout?: string;
  stderr?: string;
  /** Omit for success. Present => the tool_result is an error with this code. */
  exitCode?: number;
  denied?: boolean;
}

let line = 0;

function record(type: string, extra: Record<string, unknown>): string {
  line += 1;
  return JSON.stringify({
    type,
    uuid: `u${line}`,
    sessionId: extra['sessionId'],
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, line)).toISOString(),
    cwd: extra['cwd'],
    gitBranch: extra['gitBranch'],
    version: '2.1.181',
    ...extra,
  });
}

export interface SessionSpec {
  id: string;
  cwd: string;
  branch: string;
  /** Interleaved script: a command to run, or prose the assistant says. */
  script: Array<{ exec: ExecSpec } | { say: string } | { tool: string }>;
}

/**
 * Render a session to Claude Code JSONL. Mirrors the real shape: `tool_use` in an
 * assistant record, `tool_result` in the following user record, structured
 * `toolUseResult` alongside it, `Exit code N` prefix only on failure.
 */
export function renderSession(spec: SessionSpec): string {
  const lines: string[] = [];
  const base = { sessionId: spec.id, cwd: spec.cwd, gitBranch: spec.branch };
  let n = 0;

  for (const step of spec.script) {
    if ('say' in step) {
      lines.push(
        record('assistant', {
          ...base,
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: step.say }],
          },
        }),
      );
      continue;
    }
    if ('tool' in step) {
      lines.push(
        record('assistant', {
          ...base,
          message: {
            model: 'claude-opus-4-8',
            content: [{ type: 'tool_use', id: `t${(n += 1)}`, name: step.tool, input: { code: '1+1' } }],
          },
        }),
      );
      continue;
    }

    const { command, stdout = '', stderr = '', exitCode, denied } = step.exec;
    const id = `t${(n += 1)}`;
    lines.push(
      record('assistant', {
        ...base,
        message: {
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'run a command' } }],
        },
      }),
    );

    const failed = exitCode !== undefined && exitCode !== 0;
    const content = denied === true
      ? "The user doesn't want to proceed with this tool use. The tool use was rejected."
      : failed
        ? `Exit code ${exitCode}\n${stdout}${stderr}`
        : stdout;
    lines.push(
      record('user', {
        ...base,
        toolUseResult: denied === true
          ? 'The user doesn\'t want to proceed'
          : { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false },
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, content, is_error: failed || denied === true }],
        },
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}
/** Write sessions into a throwaway `~/.claude/projects`-shaped tree. */
export function writeTranscriptRoot(specs: SessionSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'land-test-'));
  for (const spec of specs) {
    const dir = join(root, spec.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${spec.id}.jsonl`), renderSession(spec));
  }
  return root;
}
