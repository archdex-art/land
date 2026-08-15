/**
 * Execution-claim extraction from assistant prose.
 *
 * This is the input to the only accusation the product makes, so it is tuned for
 * precision at the direct cost of recall (ADR-010). A missed claim costs a badge
 * we could have shown; a fabricated claim accuses a developer's agent of lying
 * about something it never said. Those are not symmetric, so every ambiguous
 * construction is dropped.
 *
 * Three guards do most of the work, and each was derived from false positives
 * observed in real transcripts:
 *
 *   - INTENT. "Let me run the production build to validate all routes compile"
 *     is a plan, not a claim. Any forward-looking or modal marker disqualifies
 *     the sentence.
 *   - INSTRUCTION. "Build: `npm install && npm run build`." is documentation
 *     addressed to the user. Fenced code, table rows and bare command recipes
 *     are removed before sentence splitting.
 *   - MIXED OUTCOME. "Tests pass now (they failed before)" is a true statement
 *     whose polarity we cannot resolve with a regex, so we abstain.
 */

import type { Activity } from './commands.ts';
import type { Session, Utterance } from './transcript.ts';

export type ClaimActivity = Extract<Activity, 'test' | 'build' | 'typecheck' | 'lint'>;

export interface Claim {
  activity: ClaimActivity;
  /** 'pass' asserts an outcome; 'ran' asserts only that it executed. */
  assertion: 'pass' | 'ran';
  /** The exact sentence, quoted back to the user as evidence. */
  sentence: string;
  /** Transcript line of the utterance, used to bound the search for evidence. */
  seq: number;
  ts: string | undefined;
}

/**
 * Forward-looking, modal, conditional or interrogative — never a claim.
 * `to pass` / `to compile` are purpose clauses: "update the tests to pass the
 * new field" describes work to do, not a suite that passed.
 */
const INTENT =
  /\b(?:i'?ll|i will|we'?ll|we will|let me|let'?s|lets|going to|gonna|about to|plan to|planning|next step|need to|needs to|should|shall|would|could|might|may|must|want to|try to|trying to|to run|to verify|to confirm|to check|to validate|to make sure|to pass|to compile|to build|before|after|once|if|when|unless|whether|pending|remaining|todo|first|then i|now i|now let|you can|you could|you should|please|make sure)\b/i;

/** Reports of failure or partial success — real, but not a claim of success. */
const NEGATIVE =
  /\b(?:fail(?:s|ed|ing|ure|ures)?|not pass|isn'?t pass|aren'?t pass|don'?t pass|doesn'?t pass|didn'?t pass|no longer pass|broken|breaks|regress\w*|red|error(?:s|ed)?|panick?\w*|crash\w*|timed out|flaky|skipped|cannot|can'?t|unable)\b/i;

/**
 * A sentence that is a recipe, heading, or imperative — not an assertion about
 * the past. The imperative-opener list matters: agents narrate their next action
 * in exactly this form ("Now verify the frontend compiles cleanly:").
 */
const INSTRUCTION =
  /^\s*(?:[-*+]\s*)?(?:#{1,6}\s|\|)|^\s*(?:run|install|build|execute|start|deploy|add|set|use|see|note)\b\s*[:`]|^\s*(?:now\s+|next\s+|then\s+)?(?:update|updating|add|adding|fix|fixing|change|changing|modify|create|creating|write|writing|remove|removing|refactor|wire|wiring|implement|adjust|verify|verifying|check|checking|confirm|confirming|ensure|run|running|rebuild|re-run|rerun)\b/i;

interface ClaimPattern {
  activity: ClaimActivity;
  assertion: 'pass' | 'ran';
  re: RegExp;
}

/**
 * Bounded gaps (`{0,60}`) keep a subject and its outcome inside one clause. An
 * unbounded gap happily connects "the tests" in one clause to "passes" three
 * clauses later, about something else entirely.
 */
const PATTERNS: readonly ClaimPattern[] = [
  {
    // `checks?` and `assertions?` were here and produced the only two false
    // accusations in the 18-session corpus: "the no-duplicate-names check
    // already passed" and "its gradient check passing < 1e-5". Neither is a
    // claim about a test suite. Test vocabulary must be test-specific.
    activity: 'test',
    assertion: 'pass',
    re: /\b(?:tests?|test suites?|suites?|unit tests?|specs?|pytest|jest|vitest)\b[^.;!?\n]{0,60}?\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|all ok)\b/i,
  },
  {
    activity: 'test',
    assertion: 'pass',
    re: /\b(?:pass(?:es|ed|ing)?|green)\b[^.;!?\n]{0,40}?\b(?:tests?|test suite|specs?)\b/i,
  },
  {
    activity: 'test',
    assertion: 'ran',
    re: /\b(?:i|we)\s*(?:'ve|have|had)?\s*(?:just\s+)?(?:ran|run|executed|invoked)\b[^.;!?\n]{0,40}\b(?:tests?|test suite|pytest|jest|vitest|cargo test|go test|specs?)\b/i,
  },
  {
    activity: 'build',
    assertion: 'pass',
    re: /\b(?:builds?|compilation|bundle)\b[^.;!?\n]{0,50}?\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|successful|clean|green|compiles?|compiled|works?)\b/i,
  },
  {
    activity: 'build',
    assertion: 'pass',
    re: /\b(?:compiles?|compiled|builds?)\s+(?:cleanly|clean|fine|successfully|without (?:any )?(?:errors?|warnings?))\b/i,
  },
  {
    activity: 'typecheck',
    assertion: 'pass',
    re: /\b(?:typecheck(?:s|ing)?|type-check(?:s|ing)?|type check(?:s|ing)?|tsc|mypy|pyright)\b[^.;!?\n]{0,50}?\b(?:pass(?:es|ed)?|clean(?:ly)?|green|ok)\b/i,
  },
  {
    activity: 'lint',
    assertion: 'pass',
    re: /\b(?:lint(?:s|er|ing)?|eslint|ruff|clippy|prettier|rubocop|biome)\b[^.;!?\n]{0,50}?\b(?:pass(?:es|ed)?|clean(?:ly)?|green|ok|no (?:issues|warnings|errors))\b/i,
  },
];

/**
 * Strip fenced code, indented code, inline-code-only lines and table rows.
 * Anything the agent showed rather than asserted is not a claim.
 */
function stripNonProse(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{4,}\S/.test(line)) continue;
    if (/^\s*\|/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Sentence-ish split. Abbreviations are not worth handling: over-splitting only costs recall. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Extract every execution claim from one assistant utterance. */
export function claimsFromUtterance(utterance: Utterance): Claim[] {
  const found: Claim[] = [];
  for (const sentence of sentences(stripNonProse(utterance.text))) {
    // A sentence ending in `?` asks; one ending in `:` introduces the action
    // that follows. Neither asserts anything about the past.
    if (sentence.endsWith('?') || sentence.endsWith(':')) continue;
    if (INSTRUCTION.test(sentence)) continue;
    if (INTENT.test(sentence)) continue;
    if (NEGATIVE.test(sentence)) continue;
    // Long sentences interleave several subjects; a bounded regex cannot keep
    // subject and predicate honestly paired across that much text.
    if (sentence.length > 400) continue;

    for (const p of PATTERNS) {
      if (!p.re.test(sentence)) continue;
      const already = found.find((c) => c.activity === p.activity);
      if (already !== undefined) {
        // Keep the stronger assertion for a given activity in one sentence.
        if (already.assertion === 'ran' && p.assertion === 'pass') already.assertion = 'pass';
        continue;
      }
      found.push({
        activity: p.activity,
        assertion: p.assertion,
        sentence: sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence,
        seq: utterance.seq,
        ts: utterance.ts,
      });
    }
  }
  return found;
}

export function claimsFromSession(session: Session): Claim[] {
  return session.utterances.flatMap(claimsFromUtterance);
}
