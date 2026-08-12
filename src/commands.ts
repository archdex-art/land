/**
 * Shell command classification.
 *
 * Claude Code has no test tool: every test run is a `Bash` call, so deciding
 * "did a test run?" is string classification. Two properties matter more than
 * coverage:
 *
 *   1. A command is decomposed into segments before classification. Agents write
 *      `cd app && npm test 2>&1 | tail -20`; naive substring matching on the
 *      whole string cannot tell that the exit status belongs to `tail`.
 *   2. When the classified segment is not the last in a pipeline, the shell's
 *      exit status describes the *last* process, not the test runner. We mark
 *      that case `statusMasked`, and downstream refuses to read pass/fail from
 *      the exit code. This is the difference between an honest verdict and a
 *      false accusation, and it occurs in real transcripts constantly.
 */

export type Activity = 'test' | 'build' | 'typecheck' | 'lint' | 'install' | 'migrate' | 'other';

export interface Segment {
  text: string;
  activity: Activity;
  /** Index within the pipeline this segment belongs to; 0 = leftmost. */
  pipeIndex: number;
  /** True when a later stage in the same pipeline determines the exit status. */
  statusMasked: boolean;
}

export interface CommandAnalysis {
  segments: Segment[];
  activities: Activity[];
  /** True if any classified activity segment has its exit status masked. */
  anyStatusMasked: boolean;
}

/**
 * Matchers are anchored at a segment's first word (after stripping env
 * assignments and common wrappers) precisely so that `echo "run the tests"`
 * and `grep -r pytest .` do not register as executions.
 */
const MATCHERS: ReadonlyArray<{ activity: Activity; re: RegExp }> = [
  {
    activity: 'test',
    re: /^(?:pytest|jest|vitest|mocha|ava|tap|rspec|phpunit|ctest|nose2?|behave|cucumber|newman|k6|playwright|cypress)\b/,
  },
  { activity: 'test', re: /^(?:python\d*|py)\s+-m\s+(?:pytest|unittest|nose2?|tox)\b/ },
  { activity: 'test', re: /^cargo\s+(?:\+\S+\s+)?(?:test|nextest)\b/ },
  { activity: 'test', re: /^go\s+test\b/ },
  { activity: 'test', re: /^(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|jest|vitest)\b/ },
  { activity: 'test', re: /^(?:npx|pnpx|bunx)\s+(?:jest|vitest|mocha|ava|playwright|cypress|tap)\b/ },
  { activity: 'test', re: /^(?:mvn|gradle|\.\/gradlew|sbt)\s+.*\btest\b/ },
  { activity: 'test', re: /^(?:dotnet|swift)\s+test\b/ },
  { activity: 'test', re: /^(?:make|just)\s+(?:test|check)\b/ },
  { activity: 'test', re: /^node\s+--test\b/ },
  { activity: 'test', re: /^tox\b/ },

  { activity: 'typecheck', re: /^(?:tsc|mypy|pyright|flow)\b/ },
  { activity: 'typecheck', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc)\b/ },
  { activity: 'typecheck', re: /^(?:npx|pnpx|bunx)\s+(?:tsc|pyright)\b/ },
  { activity: 'typecheck', re: /^cargo\s+(?:\+\S+\s+)?check\b/ },

  { activity: 'lint', re: /^(?:eslint|ruff|flake8|pylint|black|prettier|rubocop|golangci-lint|shellcheck|biome)\b/ },
  { activity: 'lint', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|format|fmt)\b/ },
  { activity: 'lint', re: /^(?:npx|pnpx|bunx)\s+(?:eslint|prettier|biome)\b/ },
  { activity: 'lint', re: /^cargo\s+(?:\+\S+\s+)?(?:clippy|fmt)\b/ },
  { activity: 'lint', re: /^go\s+vet\b/ },

  { activity: 'build', re: /^(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?build\b/ },
  { activity: 'build', re: /^(?:next|vite|webpack|rollup|esbuild|tsup|parcel)\s+build\b/ },
  { activity: 'build', re: /^(?:npx|pnpx|bunx)\s+(?:next|vite|webpack|tsup)\s+build\b/ },
  { activity: 'build', re: /^cargo\s+(?:\+\S+\s+)?(?:build|rustc)\b/ },
  { activity: 'build', re: /^go\s+build\b/ },
  { activity: 'build', re: /^(?:make|just)\b(?!\s+(?:test|check|lint))/ },
  { activity: 'build', re: /^(?:cmake|ninja|bazel|gradle|mvn|dotnet|swift)\s+(?:build|--build|compile|package)\b/ },
  { activity: 'build', re: /^docker(?:\s+buildx)?\s+build\b/ },
  { activity: 'build', re: /^bun\s+build\b/ },

  { activity: 'install', re: /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b/ },
  { activity: 'install', re: /^(?:pip\d*|pip3|uv|poetry|cargo|go|brew|apt|apt-get)\s+(?:install|add|get|sync)\b/ },

  { activity: 'migrate', re: /^(?:alembic|flyway|liquibase|goose|sqlx|dbmate|atlas)\b/ },
  { activity: 'migrate', re: /^(?:npx|pnpx|bunx)?\s*(?:prisma|drizzle-kit|knex|sequelize)\b.*\b(?:migrate|migration|push|deploy)\b/ },
  {
    activity: 'migrate',
    re: /^(?:python\d*\s+)?manage\.py\s+migrate\b|^(?:php\s+)?artisan\s+migrate\b|^(?:bundle\s+exec\s+)?rails?\s+db:migrate\b/,
  },
  { activity: 'migrate', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:migrate|db:migrate)\b/ },
];

/** Leading `FOO=bar`, `sudo`, `time`, `env X=y`, and subshell noise. */
const PREFIX_NOISE = /^(?:\(\s*|\{\s*|!\s*|sudo(?:\s+-\S+)*\s+|env\s+|time\s+|nice(?:\s+-n\s*\d+)?\s+|command\s+|exec\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/**
 * Split a command into pipeline segments, tracking pipeline position.
 * Handles `&&`, `||`, `;`, `|`, `&`, and newlines, while leaving quoted regions
 * intact: `grep -E "test result|error"` must not split on the `|` inside quotes.
 */
export function splitSegments(command: string): Array<{ text: string; pipeIndex: number; lastInPipe: boolean }> {
  const out: Array<{ text: string; pipeIndex: number; lastInPipe: boolean }> = [];
  let buf = '';
  let pipeIndex = 0;
  let quote: '"' | "'" | null = null;
  /** Segments of the current pipeline, so the last one can be marked. */
  let pipeline: number[] = [];

  const flush = (endsPipeline: boolean) => {
    const text = buf.trim();
    if (text !== '') {
      out.push({ text, pipeIndex, lastInPipe: false });
      pipeline.push(out.length - 1);
    }
    buf = '';
    if (endsPipeline) {
      const last = pipeline.at(-1);
      if (last !== undefined) out[last]!.lastInPipe = true;
      pipeline = [];
      pipeIndex = 0;
    } else {
      pipeIndex += 1;
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      buf += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush(true);
      i += 1;
      continue;
    }
    if (two === '|&') {
      flush(false);
      i += 1;
      continue;
    }
    if (ch === '|') {
      flush(false);
      continue;
    }
    if (ch === '&') {
      // `2>&1`, `>&2`, `&>log` are redirections, not separators. Splitting here
      // truncated the pipeline and made `cargo test … 2>&1 | tail` look like the
      // last stage, so its masked exit status was read as authoritative.
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === '>' || prev === '<' || next === '>') {
        buf += ch;
        continue;
      }
      flush(true);
      continue;
    }
    if (ch === ';' || ch === '\n') {
      flush(true);
      continue;
    }
    buf += ch;
  }
  flush(true);
  return out;
}

export function analyze(command: string): CommandAnalysis {
  const segments: Segment[] = [];
  const activities = new Set<Activity>();
  let anyStatusMasked = false;

  for (const raw of splitSegments(command)) {
    const text = raw.text.replace(PREFIX_NOISE, '').trim();
    let activity: Activity = 'other';
    for (const m of MATCHERS) {
      if (m.re.test(text)) {
        activity = m.activity;
        break;
      }
    }
    const statusMasked = activity !== 'other' && !raw.lastInPipe;
    if (activity !== 'other') {
      activities.add(activity);
      if (statusMasked) anyStatusMasked = true;
    }
    segments.push({ text, activity, pipeIndex: raw.pipeIndex, statusMasked });
  }

  return { segments, activities: [...activities], anyStatusMasked };
}

// ---------------------------------------------------------------------------
// Outcome recovery from output
// ---------------------------------------------------------------------------

export type OutputVerdict = 'passed' | 'failed' | 'none';

/**
 * Runner summary lines, scoped per activity.
 *
 * The scoping is not cosmetic. Agents habitually chain a linter and a test
 * runner into one shell invocation:
 *
 *     ruff check src --fix 2>&1 | tail -3; echo "=== tests ==="; pytest -q | tail -3
 *
 * One output blob, two activities. With a single flat pattern list, ruff's
 * `Found 1 error.` marked the *tests* as failing and produced a false
 * CONTRADICTED accusation against a suite that had just printed `[100%]`.
 * A sign may therefore only be consulted for the activity whose tool emits it.
 *
 * Failure signs are held to a higher bar than success signs: a false `failed`
 * becomes an accusation, while a false `none` merely declines to give a verdict.
 */
interface Signs {
  fail: readonly RegExp[];
  pass: readonly RegExp[];
}

const SIGNS: Record<Activity, Signs> = {
  test: {
    fail: [
      /^\s*test result:\s*FAILED/m,
      /\bfailures=[1-9]/,
      /\b[1-9]\d*\s+failed\b/i,
      /\bTests:\s+(?:\d+\s+\w+,\s+)*[1-9]\d*\s+failed/i,
      /^FAIL\b/m,
      /^\s*FAILED\b/m,
      /^---\s*FAIL:/m,
      /=+\s*(?:FAILURES|ERRORS)\s*=+/,
      /\b[1-9]\d*\s+(?:test|example|assertion)s?\s+(?:failed|errored)\b/i,
      // pytest progress line containing a failure or error marker.
      /^[.sxX]*[FE][.sxXFE]*\s+\[\s*\d+%\]/m,
    ],
    pass: [
      /^\s*test result:\s*ok\./m,
      /\b[1-9]\d*\s+passed\b/i,
      /\b(?:all\s+)?[1-9]\d*\s+tests?\s+(?:passed|ok)\b/i,
      /^Tests:\s+[1-9]\d*\s+passed/im,
      /^ok\s+\S+\s+[\d.]+s/m,
      /^PASS\b/m,
      /\bno tests? ran\b/i,
      // pytest progress line of successes, skips and expected failures only.
      /^[.sxX]+\s+\[\s*\d+%\]/m,
    ],
  },
  build: {
    fail: [
      /\bBUILD FAILED\b/i,
      /\bFailed to compile\b/i,
      /\berror\[E\d+\]/,
      /\bcompilation (?:failed|error)/i,
      /\bnpm ERR!/,
      /\bCommand failed with exit code [1-9]/i,
    ],
    pass: [
      /\bCompiled successfully\b/i,
      /^\s*[✓√]\s+Compiled\b/m,
      /\bwebpack compiled successfully\b/i,
      /^\s*Finished\b[^\n]*\bin\s+[\d.]+m?s/m,
      /\bBUILD SUCCESS(?:FUL)?\b/i,
      /\bBuild (?:succeeded|successful|complete[d]?)\b/i,
      /\bSuccessfully (?:built|tagged)\b/i,
      /\bnaming to docker\.io/,
      /^Route \(app\)/m,
      /\bGenerating static pages \(\d+\/\d+\)/,
    ],
  },
  typecheck: {
    fail: [/\berror TS\d+/, /\bFound [1-9]\d* errors?\b/i, /^\s*[1-9]\d*\s+error\b/im],
    pass: [/^\s*Found 0 errors\b/m, /^\s*Success: no issues found/m, /\bno issues found\b/i],
  },
  lint: {
    fail: [/\bFound [1-9]\d* errors?\b/i, /^\s*[1-9]\d*\s+error\b/im, /^\s*[✖✗x]\s+[1-9]\d*\s+problems?\b/im],
    pass: [/\ball checks passed\b/i, /\bno (?:issues|problems|errors) found\b/i, /^\s*Found 0 errors\b/m],
  },
  // Nothing is claimed about these, so nothing is inferred from their output.
  install: { fail: [], pass: [] },
  migrate: { fail: [], pass: [] },
  other: { fail: [], pass: [] },
};

/**
 * Read pass/fail for one activity out of a command's combined output.
 * `none` means: do not guess.
 */
export function verdictFromOutput(output: string, activity: Activity): OutputVerdict {
  if (output.trim() === '') return 'none';
  const signs = SIGNS[activity];
  for (const re of signs.fail) if (re.test(output)) return 'failed';
  for (const re of signs.pass) if (re.test(output)) return 'passed';
  return 'none';
}
