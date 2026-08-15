# land

**Prove what your coding agents actually ran.**

`land` reads the session transcripts your AI coding agents already write to disk and
reconciles what an agent *said* it did against what it *observably did*. One badge:

```
✗ CONTRADICTED  Action_classification/HEAD    lint claimed passing, observed failing
                                              1 session · 90 commands · 137 edits · 714,295 tokens

Read first: Action_classification/HEAD (1 of 11 branches)
```

That branch's agent wrote *"Lint clean, 27 tests pass"*. `ruff` had printed
`Found 1 error.` The tests really did pass. `land` can tell you which half was true.

## Why

Agent output roughly doubled; review capacity did not. PR review time is up 91%
(Faros AI, 1,255 teams) and agentic PRs sit 5.3× longer before pickup (LinearB,
8.1M PRs). Every tool on the market optimises *launching* agents. `land` is for
the other direction: deciding which of last night's branches you can land unread.

The first thing a reviewer needs is not a diff. It is to know whether the agent's
summary can be trusted at all — because every other tool in the stack, including
the agent's own vendor, takes that summary at face value.

## Install

Needs Node ≥ 22.6 and nothing else. No daemon, no account, no build step.

```sh
git clone <this repo> && cd land
node src/cli.ts queue --repo ~/dev/myrepo
```

## Use

```sh
land queue                        # risk-ranked view of every agent branch
land evidence --branch fix/auth   # every claim, its verdict, the command behind it
land ui                           # self-contained HTML report — open or share
land ingest                       # append sessions to the hash-chained evidence store
land verify                       # recompute the chain, report the first divergence
```

Every command takes `--json`, and every surface reports the same rows — one per
(repo, branch) pair. Exit code is `1` when something needs reading and `2` when
the evidence chain is broken, independent of output format, so `land queue --json`
works as a CI gate.

### Two sources

By default the read commands parse the transcripts on this machine. Pass
`--store` explicitly and they read the evidence database instead — the only
thing that works for a session recorded somewhere else:

```sh
land ingest --all --store ./evidence.db   # on the machine that ran the agents
land queue  --all --store ./evidence.db   # anywhere, with no transcripts present
```

Both sources produce identical verdicts. Verdicts are recomputed on read in
either case, never read back out of storage, so improving the reconciler never
has to invalidate stored history.

`land ingest` is incremental in both directions: an unchanged transcript is
skipped on a `stat` rather than a parse, and a session that was still running
when it was first ingested gets its new events appended on the next run.

## Verdicts

| | Meaning |
|---|---|
| `✓ VERIFIED` | The claim is backed by an observed run that we can see succeeded. |
| `✗ CONTRADICTED` | The agent claimed success; the observed run failed. |
| `⚠ UNSUPPORTED` | The agent claimed it. No such command was ever run. |
| `? UNKNOWN` | Not determinable. Reported as such, never guessed. |

`UNKNOWN` is a feature. A trust tool that cries wolf once is muted forever, so
`land` abstains whenever the transcript cannot settle the question: output piped
past the exit status, a command the user declined, an MCP tool that can execute
code we cannot inspect, or a claim made before the run it refers to.

Measured on the 18 real sessions in this repository's development corpus: 84
`VERIFIED`, 7 `UNKNOWN`, 1 `CONTRADICTED` (a true positive), **0 false
accusations**. The two false positives found during development are documented as
regression comments in `src/claims.ts` — they were both the word "check".

## HTML report

`land ui` generates a single self-contained HTML file — no server, no network
requests, no external dependencies. CSP is `default-src 'none'`. Send it to a
reviewer, attach it to a PR, archive it for audits. It includes filtering,
keyboard navigation (`/` to search), a "needs attention" toggle, and works in
both light and dark mode.

```sh
land ui --out evidence.html --no-open   # write without launching a browser
land ui --all                           # every session on this machine
```

## What it does not do

- It is not a terminal, an agent runner, or a merge queue. It integrates with what
  you already use and never asks you to switch.
- It does not predict semantic conflicts across branches yet. That is the next
  milestone and is deliberately absent rather than stubbed.
- It cannot prove a negative about the whole world — only about what a transcript
  shows. Claims stay narrow on purpose.

## Privacy

Everything is local. Nothing leaves the machine.

Command output is redacted **before** it is written, never at read time, so no raw
credential ever lands on disk. Redaction covers prefixed credential families (AWS,
GitHub, Anthropic, OpenAI, Google, Slack, Stripe, npm, JWT, private keys, database
URLs), sensitive key/value assignments, and an entropy sweep over assigned values.
On the development corpus it caught a live Upstash Redis REST token in a shell
command. Output is truncated after redaction so a secret cannot survive at the cut.

## Evidence store

Observations are appended to a SQLite database as a SHA-256 hash chain, with
`UPDATE` and `DELETE` blocked by triggers. `land verify` recomputes the chain and
names the first divergence. Verdicts are *not* stored — they are derived on read,
so an opinion can never drift from the evidence it describes.

Only the `events` table is append-only. The session row beside it is metadata —
token totals, end time — which legitimately moves as a session continues;
rewriting a token count cannot alter what the chain says happened.

Re-ingesting a transcript that has grown appends its new tail. This matters more
than it sounds: agents write to a transcript *while they work*, so a session
ingested mid-run is a prefix of the real one. An earlier version treated a known
session id as a no-op, which meant a store ingested during a run would exonerate
an agent that a live parse convicts — the lie simply arrived after the snapshot.
Existing events and their hashes are never touched.

## Design

```
src/transcript.ts   Claude Code JSONL → normalized session (schema derived empirically)
src/commands.ts     shell command classification + runner-output verdicts
src/claims.ts       execution-claim extraction from assistant prose
src/reconcile.ts    claimed vs observed → verdict, with abstention
src/redact.ts       write-time secret redaction
src/store.ts        hash-chained SQLite evidence store
src/discover.ts     locate transcripts for a repository
src/html.ts         tagged-template escaping (security boundary — XSS defence)
src/report.ts       self-contained HTML report generator
src/render.ts       terminal output
src/cli.ts          commands, JSON contract
```

Three findings from the transcript format drive most of the code, and none are
documented upstream:

1. **There is no exit code.** A failing `Bash` result carries `is_error: true` and
   a content string beginning `Exit code N`; a succeeding one carries neither. Exit
   0 is inferred, never read.
2. **There is no test tool.** Tests run through `Bash`, so identifying them is
   classification, not lookup — and `cargo test 2>&1 | tail -20` exits with
   `tail`'s status, which is 0 however the tests went. `land` detects that masking
   and falls back to the runner's own summary, per activity, or abstains.
3. **A tool result can mean the user said no.** A declined command is a
   *non-execution* and is excluded from evidence entirely, so a refused `npm test`
   can never stand as proof that tests ran.

## Tests

```sh
node --test "test/*.test.ts"
```

44 tests. The reconciliation tests are the specification; the html.ts tests
encode the XSS defence contract.

## License

MIT.
