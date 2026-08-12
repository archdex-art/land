/**
 * Locate agent session transcripts for a repository.
 *
 * Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/*.jsonl`,
 * where the encoding replaces every non-alphanumeric character with `-`. That
 * encoding is lossy (`contentcreation_ideas` and `contentcreation-ideas` collide),
 * so the directory name is a fast path only: the authoritative filter is each
 * session's own recorded `cwd`. When the fast path misses we fall back to
 * scanning, which costs a few milliseconds and never silently returns nothing.
 */

import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function projectsRoot(): string {
  return process.env['LAND_TRANSCRIPT_ROOT'] ?? join(homedir(), '.claude', 'projects');
}

export function encodePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

function jsonlIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(dir, e.name));
}

/**
 * Transcript files plausibly belonging to `repo`. Returns every candidate; the
 * caller filters precisely on the parsed `cwd`, because a repo and its
 * subdirectories are distinct project dirs but the same repository.
 */
export function transcriptsFor(repo: string): string[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const target = encodePath(resolve(repo));
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // A session in a subdirectory of the repo is still a session about the repo.
    .filter((e) => e.name === target || e.name.startsWith(`${target}-`))
    .map((e) => join(root, e.name));
  if (dirs.length > 0) return dirs.flatMap(jsonlIn);
  return allTranscripts();
}

export function allTranscripts(): string[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => jsonlIn(join(root, e.name)));
}
