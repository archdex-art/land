/**
 * Write-time secret redaction (ADR-017, deny-by-default).
 *
 * Two rules govern this module:
 *   1. Nothing reaches the evidence store un-redacted. Redaction happens on the
 *      path into `store.ts`, never on the path out. A read-time redactor would
 *      leave plaintext secrets on disk, which is the failure mode we care about.
 *   2. Output is truncated before it is stored. Evidence needs the shape of a
 *      command's output (did the suite pass?), not its full text.
 *
 * Pattern sources are the well-known high-confidence prefixed-credential shapes
 * (the same families gitleaks ships as `gitleaks.toml`; MIT). We deliberately do
 * not port the full rule set: unprefixed, entropy-only rules are where secret
 * scanners generate their false positives, and here a false positive is cheap
 * (a redacted word) while a false negative is company-ending. So the prefixed
 * rules run first, and an entropy rule then sweeps anything that *looks* like an
 * assignment of a high-entropy value.
 */

export type RedactionCount = Record<string, number>;

export interface Redacted {
  text: string;
  /** kind -> number of substitutions, for auditability. */
  counts: RedactionCount;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** Which capture group holds the secret. 0 = whole match. */
  group?: number;
}

/** Order matters: specific credential shapes before generic assignments. */
const RULES: readonly Rule[] = [
  { kind: 'aws-access-key', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g },
  { kind: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g },
  { kind: 'github-oauth', re: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: 'anthropic-key', re: /\b(sk-ant-[A-Za-z0-9\-_]{20,})/g },
  { kind: 'openai-key', re: /\b(sk-(?:proj-)?[A-Za-z0-9\-_]{20,})/g },
  { kind: 'google-api-key', re: /\b(AIza[A-Za-z0-9\-_]{35})\b/g },
  { kind: 'slack-token', re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g },
  { kind: 'stripe-key', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g },
  { kind: 'npm-token', re: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { kind: 'hf-token', re: /\b(hf_[A-Za-z0-9]{30,})\b/g },
  { kind: 'jwt', re: /\b(eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,})\b/g },
  { kind: 'private-key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { kind: 'bearer', re: /\b(?:Bearer|Authorization:\s*Bearer)\s+([A-Za-z0-9\-._~+/]{16,}=*)/gi, group: 1 },
  { kind: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1 },
  { kind: 'pg-url', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s]+/gi },
];

/**
 * Keys whose value is a secret regardless of entropy. `.env`-style assignments
 * and `--flag=value` / `KEY: value` forms all reduce to this.
 *
 * `AUTH` is bounded by `(?![A-Za-z])` because the bare substring matched
 * `Co-Authored-By:` in every git commit message the agent wrote, redacting the
 * co-author trailer. A redactor that mangles ordinary output teaches users to
 * ignore the marker, which costs more than the rule saves.
 */
const SENSITIVE_KEY =
  /\b([A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTHORIZATION|AUTH(?![A-Za-z])|CREDENTIALS?|SESSION[_-]?KEY|ENCRYPTION[_-]?KEY)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s"'&|;)\n]{6,}))/gi;

/** Entropy sweep: an assignment of a long, high-entropy, single-token value. */
const ASSIGNED_VALUE =
  /\b([A-Za-z_][A-Za-z0-9_.-]{2,})\s*=\s*(?:"([A-Za-z0-9+/_-]{24,}={0,2})"|'([A-Za-z0-9+/_-]{24,}={0,2})'|([A-Za-z0-9+/_-]{24,}={0,2})\b)/g;

const ENTROPY_THRESHOLD = 3.6;

/** Shannon entropy in bits/char. Cheap, and the standard signal for this. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Values that trip the entropy rule but are structurally not secrets. Hashes,
 * digests and filesystem paths are the common cases in agent transcripts;
 * keeping them readable matters for triage, and none of them are credentials.
 */
function looksLikeNonSecret(key: string, value: string): boolean {
  if (/^(?:sha\d*|hash|digest|commit|rev|revision|checksum|integrity|etag|uuid|id)$/i.test(key)) return true;
  // Pure hex of a standard digest length.
  if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) return true;
  // A filesystem path. `PYTHON=/Library/Frameworks/Python.framework/…` is long
  // and mixed-case enough to clear the entropy bar, and redacting it destroyed
  // the most useful line in an environment probe.
  if (/^[~.]?\//.test(value) || /\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}(?:\/|$)/.test(value)) return true;
  return false;
}

const PLACEHOLDER = (kind: string) => `«redacted:${kind}»`;

function replaceAll(text: string, re: RegExp, kind: string, counts: RedactionCount, group = 0): string {
  return text.replace(re, (match, ...groups) => {
    const secret = group === 0 ? match : (groups[group - 1] as string | undefined);
    if (!secret) return match;
    counts[kind] = (counts[kind] ?? 0) + 1;
    return match.replace(secret, PLACEHOLDER(kind));
  });
}

/**
 * Redact a text blob. Idempotent: placeholders contain no characters that any
 * rule matches, so re-running produces identical output.
 */
export function redact(input: string): Redacted {
  const counts: RedactionCount = {};
  let text = input;

  for (const rule of RULES) {
    text = replaceAll(text, rule.re, rule.kind, counts, rule.group ?? 0);
  }

  text = text.replace(SENSITIVE_KEY, (match, key: string, dq?: string, sq?: string, bare?: string) => {
    const secret = dq ?? sq ?? bare;
    if (!secret || secret.startsWith('«redacted:')) return match;
    // Obvious placeholders in docs/examples are not secrets and redacting them
    // produces noise that trains users to ignore the marker.
    if (/^(?:your|my|the|<|\$\{?|xxx+|placeholder|changeme|example|todo|none|null|true|false)/i.test(secret)) {
      return match;
    }
    counts['sensitive-key'] = (counts['sensitive-key'] ?? 0) + 1;
    return match.replace(secret, PLACEHOLDER('sensitive-key'));
  });

  text = text.replace(ASSIGNED_VALUE, (match, key: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare;
    if (!value || value.startsWith('«redacted:')) return match;
    if (looksLikeNonSecret(key, value)) return match;
    if (entropy(value) < ENTROPY_THRESHOLD) return match;
    counts['high-entropy'] = (counts['high-entropy'] ?? 0) + 1;
    return match.replace(value, PLACEHOLDER('high-entropy'));
  });

  return { text, counts };
}

/**
 * Redact then truncate. Truncation is deliberately after redaction so a secret
 * spanning the cut boundary cannot survive as a fragment.
 */
export function redactAndTruncate(input: string, maxBytes: number): Redacted & { truncated: boolean } {
  const { text, counts } = redact(input);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, counts, truncated: false };
  // Keep the head and the tail: test runners put the summary at the end and the
  // failing assertion near the start.
  const head = Math.floor(maxBytes * 0.4);
  const tail = maxBytes - head;
  const buf = Buffer.from(text, 'utf8');
  const kept = `${buf.subarray(0, head).toString('utf8')}\n…[${buf.length - maxBytes} bytes elided]…\n${buf.subarray(buf.length - tail).toString('utf8')}`;
  return { text: kept, counts, truncated: true };
}

export function mergeCounts(into: RedactionCount, from: RedactionCount): RedactionCount {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  return into;
}
