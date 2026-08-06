# SuperTerminal — Founding Research & Strategy

**Date:** August 2026
**Author's stance:** written as founding engineer / CTO / PM — and deliberately, in §5, as a skeptical user.
**Status:** pre-code. Nothing has been built. This is the document that decides *what* gets built.

---

## 0. TL;DR

1. **The ChatGPT thread was built on a factual error.** It assumed "cmux" meant tmux. cmux is a real, funded product (Manaflow, YC S24) — a macOS-native terminal built on libghostty *specifically for running parallel AI coding agents*. It is not a multiplexer concept; it is a direct competitor that already shipped.
2. **Warp open-sourced its client in April 2026** (AGPL-3.0 / MIT dual, ~60k GitHub stars, OpenAI as founding sponsor). The terminal UI is now a **commodity you can fork for free**. Warp's actual business is **Oz**, its proprietary cloud agent orchestrator. Building "a nicer Warp UI" in 2026 is building something your competitor gives away.
3. Therefore: **do not build a terminal emulator.** Twelve-plus tools already do parallel-agent multiplexing. That category is crowded, commoditising, and losing its moat monthly.
4. **The unsolved problem is the other direction.** Every tool on the market optimises *fan-out* — launching, isolating, and watching N agents. The 2026 data says the bottleneck moved to *fan-in*: PR review time is up **91%**, agentic PRs sit **5.3× longer** before pickup, **96%** of developers don't fully trust AI code, and AI-written code surfaces **1.7× more issues**. LinearB's analysis of 8.1M PRs found developers *feel* 20% faster and are measurably **19% slower**.
5. **The wedge: SuperTerminal is the fan-in console.** Not "run more agents" — **"trust and land the agents you already ran."** Two defensible primitives: (a) **semantic conflict prediction across parallel agents** using a code graph, and (b) **evidence bundles** that make an agent's work reviewable in 90 seconds instead of 40 minutes.
6. This is the only framing where your existing assets (CodeGraph, SuperSearch, AgentMesh) are a *moat* rather than a distraction, and it's the only one a small team can ship in 8–10 weeks rather than 18 months.

---

## 1. Correcting the premise

The prior analysis is well-written and its instincts are good, but it reasons from two stale/incorrect facts. Both invert the conclusion.

### 1.1 cmux is not tmux

| What the thread assumed | What cmux actually is |
|---|---|
| "cmux ≈ tmux/Zellij, terminal multiplexing" | Native macOS app, **Swift + libghostty** (Ghostty's embeddable rendering engine) |
| A generic capability to combine with Warp | A shipped product by **Manaflow (YC S24)**, GPL-3.0 core + paid Founder's Edition |
| Panes and sessions | **Workspace tabs per agent**, vertical sidebar showing git branch + PR status + listening ports + latest agent notification |
| — | **Embedded WebKit browser** agents can snapshot, click and script |
| — | **Notification rings on pane borders** when an agent needs input |
| — | Scriptable CLI over a **Unix socket, 40+ subcommands**; native `cmux claude-teams` integration |
| — | SSH workspaces, SCP drag-and-drop, localhost routing, session restore |

So "Warp + cmux hybrid" does not describe a gap. It describes **two products that have already converged on the same answer**. cmux *is* the Warp-UI-plus-multiplexer-plus-agents product. It exists, it's funded, it's polished, and it's free.

**Implication:** the plan as originally framed has already been executed by someone with a head start and YC money. You cannot enter here on execution quality alone.

### 1.2 Warp gave away the part you were going to build

April 28, 2026: Warp open-sourced the terminal client, dual-licensed MIT/AGPL-3.0. ~60k stars. OpenAI is founding sponsor. The Rust GPU-accelerated client, the block model, the input editor — all public.

What stayed closed: **Oz**, the cloud orchestration platform that runs multiple agents in parallel with task lists and progress tracking. Pricing consolidated to **$20/mo Build** (1,500 credits, BYOK for OpenAI/Anthropic/Google), **$50/user/mo Business** (SSO, zero-data-retention, shared credits, ≤50 seats), Enterprise custom.

Read the strategy honestly: **Warp is not becoming an open-source project. It is becoming an enterprise SaaS company with an open-source frontend.** They commoditised the client precisely because the client is no longer where value accrues.

**Implication #1:** every hour you spend on VT100 parsing, ANSI edge cases, ConPTY quirks, glyph shaping and 120fps scrollback is an hour spent rebuilding something now available free under MIT. This is the single most expensive mistake available to you.

**Implication #2 (the good news):** this is a *gift*. You can build on top of libghostty (as cmux did) or the open Warp client, and skip 12 months of the hardest, least differentiated work. The prior analysis listed "terminal compatibility" and "cross-platform PTY" as Risks #1 and #2. **In 2026 those risks are purchasable at zero cost.** Do not re-buy them.

---

## 2. Market map — where value actually sits

Three layers. Value is draining out of the bottom two and pooling at the top.

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 3 — VERIFICATION / FAN-IN            ←  EMPTY         │
│  Deciding whether agent output is safe to land               │
│  Nobody owns this. This is the opportunity.                  │
├──────────────────────────────────────────────────────────────┤
│  LAYER 2 — ORCHESTRATION / FAN-OUT          ←  CROWDED       │
│  amux · cmux · dmux · workmux · ittybitty · Termdock ·       │
│  Superset · Conductor · Sculptor · Vibe Kanban · Warp Oz ·   │
│  Claude Code Agent Teams · Cursor BG Agents · Devin ·        │
│  OpenHands                    (12+ tools, ~18 months old)    │
├──────────────────────────────────────────────────────────────┤
│  LAYER 1 — TERMINAL EMULATION               ←  COMMODITISED  │
│  Ghostty (Zig, ~4× iTerm2 throughput, libghostty embeddable) │
│  Warp client (now MIT/AGPL) · WezTerm · Kitty · Alacritty    │
│  tmux · Zellij               (free, mature, forkable)        │
└──────────────────────────────────────────────────────────────┘
```

The critical structural fact: **Layer 2 is being absorbed by the model vendors.** Claude Code ships `--agent-teams` (parallel sub-agents in worktrees, zero install). Cursor ships Background Agents. Warp ships Oz. When the people who sell the tokens give away the orchestration, third-party orchestrators become a features-race with no floor. Vibe Kanban's parent company (Bloop) already shut down in April 2026 and the project went community-maintained. That is what a commoditising category looks like from the inside.

**Do not enter Layer 2.** Enter Layer 3, and consume Layer 1 and 2 as inputs.

---

## 3. Competitor teardowns — how they actually work

Understanding mechanism, not features, is what tells you where the structural weakness is.

### 3.1 Warp / Oz

**Mechanism.** Rust client, custom GPU text renderer. The famous "blocks" require **shell instrumentation**: Warp injects a shell integration hook so it can detect command start/end boundaries and attribute output to a command. That is the whole trick behind blocks, and it's also the source of its friction — exotic zsh setups, nested shells, remote sessions and unusual prompts degrade the experience. Oz runs agents server-side with per-agent task lists and its own terminal access.

**Right:** the block model was genuinely correct and everyone copies it. Best-in-class input editor. Credits + BYOK pricing is honest.

**Structural weakness:** Warp still thinks the unit of work is *a command*. In an agent world the unit of work is *a change*. Blocks give you a beautiful record of what was typed and printed — and tell you nothing about whether the resulting diff is safe. Also: 1,500 credits/mo is well under continuous agent use, so heavy users churn to BYOK, which weakens the monetisation loop.

### 3.2 cmux (your closest competitor — study it, don't fight it)

**Mechanism.** Swift shell around libghostty for rendering. Each agent gets a **workspace tab**, not a pane; workspace metadata (branch, PR, ports, last notification) is surfaced in a vertical sidebar. Embedded WebKit gives agents a browser they can drive. Control plane is a Unix socket with a 40+ command CLI, which makes the whole app scriptable — that is the smartest thing in the product.

**Right:** it correctly identified that "which agent needs me right now?" is the #1 UX problem of parallel agents, and answered it with ambient signals (notification rings, sidebar status). Native feel. Nothing else is this pleasant at a desk.

**Structural weakness, stated plainly:** macOS only. No remote access. No self-healing. No REST API. And most importantly — **cmux stops at "the agent is done."** It shows you PR status; it does not help you decide whether to merge. It is a superb cockpit with no landing gear.

### 3.3 amux

**Mechanism.** A single Python file running a local HTTPS server that drives **tmux** sessions. Self-healing watchdog restarts crashed agents, auto-compacts context overflow, detects stuck sessions. SQLite kanban with quality gates (todo → doing → done → verified). Full REST API. PWA + native iOS app.

**Right:** the only tool designed for *unattended* operation — "start agents before bed, review PRs in the morning." Mobile monitoring is a real insight. Cost tracking per session.

**Structural weakness:** git isolation is *manual*, not worktree-automatic. And note the shape of its own pitch — "review PRs in the morning" — amux's success **creates** the fan-in problem it doesn't solve. Its `verified` column is a manual checkbox. That gap is your product.

*(Caveat: the best comparison matrix in the category is published by amux itself and is not neutral. Treat its self-ratings accordingly.)*

### 3.4 The worktree-thin-layer cluster — dmux, workmux, ittybitty

**Mechanism.** `git worktree add` per agent + tmux pane per agent. ittybitty is ~200 lines of bash. workmux takes YAML task definitions. dmux is `dmux run <prompt>` and fans out.

**Right:** worktrees are the correct isolation primitive for local parallel agents, and these tools prove the whole category is ~200 lines of glue. That should worry anyone building a *large* product in Layer 2.

**Structural weakness — and this is the important one:** worktrees prevent **git** conflicts. They do nothing about **semantic** conflicts. Agent A renames `parse_config()`; agent B, in a different worktree, adds three call sites to it. Both branches merge cleanly. `main` is broken. **Nobody in this entire market solves that.** Hold this thought — it's §6.

### 3.5 Conductor / Superset / Termdock / Sculptor

- **Conductor** — YC, $22M Series A, Mac desktop, parallel Claude Code/Codex/Cursor in isolated workspaces, Linear integration. Mac-only (Windows waitlist), single-player, closed.
- **Superset** — "code editor for AI agents," GUI + worktrees + cost tracking, local and cloud.
- **Termdock** — Electron, cross-platform, per-session CPU/RAM, basic health checks, web session viewer.
- **Sculptor** — the only one using **containers rather than worktrees**. Stronger isolation; a genuinely different bet, and the right one if you care about agents that run `rm`, install packages, or mutate global state.

**Pattern across all four:** the interface metaphor differs (board vs. tabs vs. panes vs. GUI) but the model is identical — *spawn, isolate, watch, hand off to GitHub*. The handoff to GitHub is where every one of them ends and where the human's pain begins.

### 3.6 Cloud platforms — Devin, OpenHands, Cursor BG

Devin ($500+/mo) is the fully-managed end: own sandbox, browser, editor, Linear/Jira/Slack integration, knowledge base. OpenHands is the self-hosted open-source equivalent (Docker per agent, micro-agent delegation). Cursor Background Agents run in Cursor's cloud, branch per agent, PR at the end — but can't touch your local DB, tooling or env.

**Structural weakness of the whole cloud tier:** your code runs on someone else's machine, and the environment is never quite your environment. This is why local tools continue to exist despite being objectively more work.

### 3.7 Layer 1, briefly

Ghostty (Zig) is the emulator to beat — ~4× iTerm2 throughput in sustained output, and crucially **libghostty is designed to be embedded**. cmux is the proof. WezTerm wins on Lua scriptability and built-in multiplexing; Kitty on its graphics protocol; Alacritty on minimalism; Zellij is now a credible modern tmux with WASM plugins.

**Takeaway:** there is no rendering gap left to exploit. Anyone claiming a terminal is "faster" in 2026 is competing on a dimension users stopped feeling five years ago.

---

## 4. What users actually experience — the evidence

This is the part that should change your roadmap. Numbers from 2026 industry analyses:

| Signal | Value | What it means |
|---|---|---|
| Tasks completed with AI | **+21%** | Agents work. Fan-out is solved. |
| PRs merged | **+98%** | Output roughly doubled. |
| **PR review time** | **+91%** | The queue absorbed the entire gain. |
| Agentic PR pickup time | **5.3× longer** | Humans actively avoid reviewing agent PRs. |
| Developers who don't fully trust AI code accuracy | **96%** | Trust, not capability, is the binding constraint. |
| Issues in AI code vs human code | **1.7×** | The distrust is rational. |
| Perceived vs. actual speed (8.1M PRs, 4,800+ orgs) | feel **+20%**, actually **−19%** | A 39-point self-deception gap. |
| Experienced devs using agents | **−19% throughput** | Validation overhead exceeds generation savings. |
| Junior devs using agents | **+10–30%** | They're not the ones doing the verifying. |

Read those last two rows together. **AI coding tools currently make senior engineers slower.** The industry is shipping ever-better fan-out into a system whose fan-in capacity is fixed at "one human, one careful read."

Every dollar and every tool in Layer 2 makes this worse. That is a market begging for a product.

---

## 5. The uncomfortable part — thinking as the user

You asked whether the plan and the user are on the same track. Answer: **not yet.** Here is the gap, written as the developer you're trying to win.

> **"You want me to replace my terminal."**
> My terminal is the most personalised tool I own. Ten years of zsh config, aliases, keybinds, ssh config, tmux muscle memory. My switching cost isn't "download an app," it's "re-learn my hands." You need to be ~10× better, not 2×, and the last three terminals I tried were 1.2×.
>
> **"You want me to trust a new process with my shell."**
> My shell has AWS keys, prod DB URLs, `.env` files, SSH agent sockets. "AI-native" reads to me as "sends my environment somewhere." Warp already took HN criticism over exactly this. If your privacy story isn't the *first* thing on the page, I close the tab.
>
> **"You're offering me thirteen features."**
> Terminal + AI + git + docker + k8s + SSH + DB + logs + tasks + notes + architecture + pipelines + session state. I hear thirteen half-products and one more subscription. I already pay for Cursor and Claude. What is the *one* thing?
>
> **"You promise deterministic replay."**
> No you don't. The model provider changes serving behaviour, sampling isn't reproducible, my tools return live data, and half my session is me typing things at 11pm. If you claim deterministic replay and I catch you failing once, I never trust another claim you make.
>
> **"Here's what I actually want, and nobody asks me."**
> Five agents finished overnight. There are five branches. I don't know which touch the same code. I don't know which ones actually ran the tests versus claimed they did. I don't know which one is 4 lines and which is 400. I don't know what any of them did to my node_modules. **I want to land four of them in ten minutes and know precisely which one to read carefully.**

That last paragraph is your product. Everything above it is why the current plan would fail.

**Alignment check:**

| The plan proposes | The user actually asks for | Aligned? |
|---|---|---|
| Terminal Operating System | "don't touch my terminal" | ❌ |
| Everything is a workspace | "I have a workspace, it's called my repo" | ❌ |
| Everything is persistent | genuinely wanted (tmux tax is real) | ✅ but table stakes |
| Everything is searchable | wanted, weakly — Atuin already ~solves shell history | ⚠️ |
| Everything is observable (CPU/RAM dashboards) | nobody has ever asked for this | ❌ |
| Everything is automatable | wanted, but Makefiles/justfiles exist | ⚠️ |
| Deterministic replay | undeliverable as stated | ❌ |
| Plugin marketplace (15 integrations) | premature; marketplaces need users first | ❌ |
| — | **"which of these 5 agent branches is safe to merge?"** | **not in the plan at all** |

---

## 6. The wedge

> **SuperTerminal is not where you run agents. It's where you decide to trust them.**
> The fan-in console for parallel agent work.

You keep your terminal. You keep Claude Code, Codex, cmux, amux, whatever. SuperTerminal watches, and when the agents are done it tells you what happened and what's safe.

Two primitives carry the entire product. Both are things no competitor can copy quickly, because they are **code-intelligence problems**, and every competitor is a *terminal* company.

### 6.1 Primitive A — Semantic conflict prediction (the technical moat)

Worktrees give every parallel-agent tool clean *git* merges and zero protection from *semantic* breakage. This is the #1 real failure mode of parallel agents and it is universally unaddressed.

```
Agent A (worktree-a)   renames  parse_config() → load_config()
Agent B (worktree-b)   adds     3 new callers of parse_config()
Agent C (worktree-c)   changes  the return type of a shared struct

git merge → clean, clean, clean.
main      → broken.
```

**Mechanism.** Build a symbol-level graph per branch (this is CodeGraph, which you already have). For each pair of branches, diff the *symbol* deltas rather than the *text* deltas, and flag:

- symbol renamed/removed in X, referenced in Y
- signature or return-type change in X, called in Y
- both branches mutating the same function body
- schema/migration collisions
- lockfile & dependency-version divergence
- config-key drift

Output: an **N×N conflict matrix** with a merge order that minimises breakage, plus a one-line explanation per predicted collision.

**Why it's defensible:** it needs a cross-branch, symbol-resolving, multi-language code graph with incremental updates. That's a year of work for a terminal team and an existing asset for you. It's also the feature with the clearest "oh — I need this" moment: run it once on a real 5-agent session and it will catch something.

### 6.2 Primitive B — Evidence bundles (the trust moat)

Not "deterministic replay" — that promise is undeliverable and you'd be caught. The honest, achievable, *more useful* version is **provenance plus differential proof**.

For every agent run, capture a signed, append-only bundle:

- exact prompt + full tool-call trace
- model ID **and version string**, temperature, token + cost totals
- every shell command with exit code, duration, and truncated output
- files touched, symbols touched, dependency changes
- environment fingerprint (OS, runtime versions, lockfile hashes, container digest)
- test results **before and after** the patch
- what the agent *claimed* vs. what actually executed ← this one line is the product

That last item deserves emphasis. Agents routinely report "I ran the tests and they pass" without having run them. You have the PTY stream. **You can prove it.** A single badge — *"tests claimed: yes / tests observed: no"* — is worth more to a reviewer than any dashboard in this document.

Then the **Prove-It runner**: for a bug-fix branch, execute the failing case at `HEAD~` and at `HEAD`, and show the causal pair. Red → green, with receipts. That is the deliverable version of "replay," it works today, and it's a claim you can always keep.

**Standards tailwind:** cryptographic pre-execution receipts and replayable provenance map onto ISO 42001 A.6.1.6, EU AI Act Article 12, and NIST Measure 2.5. That is your enterprise wedge in year two — regulated teams will need to *prove* what an agent did to their codebase, and no terminal will be able to tell them.

### 6.3 The surface: a risk-ranked review queue

Not a kanban board, not a dashboard. One list, sorted by *what deserves your attention*:

```
▲ RISK   agent-c   auth/session.rs         +240 −18   ⚠ touches auth
                   tests: claimed ✓  observed ✗       ⚠ predicted conflict → agent-a
                   → READ THIS ONE

  MED    agent-a   api/handlers.rs         +64  −12   tests ✓ observed  cov +2.1%
                   ⚠ renames parse_config (3 refs in agent-b)  → merge FIRST

  LOW    agent-b   ui/settings.tsx         +31  −4    tests ✓  no conflicts   [merge]
  LOW    agent-d   docs/                   +88  −0    docs only              [merge]
  LOW    agent-e   tests/parser_test.rs    +45  −0    tests only             [merge]

  Suggested merge order: a → b → d → e, hold c for review
  Estimated review time: 6 min (was 41 min)
```

Three of those merge without a human read. One needs eight minutes. One needs real attention *and you know why before you open it*. **That is the entire value proposition, and it fits on one screen.**

### 6.4 The pitch, three ways

- **Engineer:** "Semantic conflict detection and execution provenance for parallel agent branches."
- **Manager:** "Your team's agent PRs merge in minutes instead of days, and you can prove what shipped."
- **Investor:** "Everyone sells more agent output. We're the only ones selling the ability to absorb it."

And the disappearance test the prior thread proposed, answered properly: if SuperTerminal vanished, users don't "go back to Warp" — they go back to reading five branches cold at 9am. They'd feel it the next morning.

---

## 7. Product roadmap

Deliberately narrow. The prior plan's Risk #4 — scope creep — is the one risk it correctly identified and then immediately violated by listing thirteen subsystems.

### v0 — "Merge Queue" (weeks 1–8) · prove the wedge

CLI + local web UI. **No terminal. No agent runner. No plugins.**

- Point it at a repo: `superterminal watch ~/dev/myrepo`
- Auto-discovers agent worktrees/branches (works with dmux, workmux, Agent Teams, Conductor, cmux, manual worktrees — anything that produces branches)
- Semantic conflict matrix across branches (start: TypeScript + Python + Rust)
- Risk-ranked review queue, sorted by blast radius
- Suggested merge order
- One-command `superterminal land` executing that order with verification between steps

**Success criterion:** ten developers running ≥3 parallel agents report that it caught a conflict they would have missed. If it doesn't, the thesis is wrong — stop and re-plan. That's a real kill criterion, and it's cheap.

### v1 — "Evidence" (weeks 9–20)

- PTY-level capture via a lightweight shim (`superterminal exec -- claude ...`) — works inside *any* terminal, no replacement required
- Full evidence bundle per run; signed, append-only
- **Claimed vs. observed** verification badges
- Prove-It differential runner (fail@parent → pass@head)
- Shareable bundle URL — send a reviewer *proof*, not a diff
- Cost/token attribution per branch

### v2 — "Trust Gates" (months 6–12)

- Policy: "no agent branch merges without observed tests + zero predicted conflicts + no changes under `auth/`"
- Team mode: shared queue, org-wide agent audit log
- Compliance export (ISO 42001 / EU AI Act Art. 12 / NIST)
- CI integration: run the conflict matrix pre-merge on GitHub

### v3 — *only if v0–v2 earn it*

Then, and only then, consider a first-class terminal surface — built on **libghostty**, never from scratch. By that point you'd have users asking for it, which is the only good reason to build one.

**Explicitly not building:** VT100 parser, GPU renderer, ConPTY layer, plugin marketplace, Docker/k8s/DB UIs, note-taking, CPU dashboards, an IDE.

---

## 8. Architecture

Small, boring, and mostly assembled from existing parts.

```
┌──────────────────────────────────────────────────────────┐
│  Surfaces:  CLI  ·  local web UI  ·  GitHub check  ·  MCP │
├──────────────────────────────────────────────────────────┤
│  Merge Planner      risk model, order solver, gates       │
├──────────────────────────────────────────────────────────┤
│  Conflict Engine  ←──── CodeGraph (existing asset)        │
│    per-branch symbol graphs · cross-branch symbol diff    │
│    incremental, cached by tree-hash                       │
├──────────────────────────────────────────────────────────┤
│  Evidence Store     append-only log + content-addressed   │
│    blobs; SQLite + hash chain; PTY capture shim           │
├──────────────────────────────────────────────────────────┤
│  Adapters   git worktrees · GitHub · Claude Code ·        │
│             Codex CLI · cmux socket · amux REST · tmux    │
└──────────────────────────────────────────────────────────┘
```

**Decisions:**

- **Rust** for the engine (correct for the graph work and for a distributable single binary), **TypeScript** for the web UI. Do not adopt a novel native UI toolkit for v0 — it buys nothing and costs weeks.
- **Parsing:** tree-sitter for syntax, LSP where available for cross-file symbol resolution. Do not write parsers.
- **Storage:** SQLite, hash-chained. Not RocksDB, not a service. Local-first.
- **Search:** ripgrep + SQLite FTS at this scale. Tantivy only when a real index is justified.
- **Privacy:** everything local by default. Nothing leaves the machine unless the user explicitly shares a bundle. Say this on the landing page, above the fold, before any feature. Given the environment-variable concern in §5, this is a *feature*, not a footnote.
- **Integration over replacement, always.** The moment you require users to switch terminals, your adoption curve dies. Adapters, not migration.

---

## 9. Risks and kill criteria

| # | Risk | Mitigation | Kill criterion |
|---|---|---|---|
| 1 | Not enough devs run parallel agents yet | Product also works for a *single* agent's branch (evidence + prove-it) | <10 weekly-active after 3 months of direct outreach |
| 2 | Conflict prediction is noisy — false positives kill trust | Ship high-precision rules first (rename/signature/schema); tune for precision over recall; every flag must be explainable in one line | Precision <80% on a 50-conflict benchmark you build in week 2 |
| 3 | GitHub/Anthropic/Cursor ships this natively | They're incentivised to sell *generation*; verification is adjacent and unglamorous. Move fast, go multi-vendor — being agent-agnostic is your structural advantage over first-party tools | A first-party ships equivalent cross-branch semantic analysis |
| 4 | Multi-language symbol resolution is genuinely hard | Ship 3 languages well, not 12 badly. Depth beats coverage in a trust product | Can't hit precision target in TS+Py+Rust by month 4 |
| 5 | Scope creep back toward "build a terminal" | This document is the contract. Re-read §7's not-building list monthly | You catch yourself writing an ANSI parser |
| 6 | Warp/Oz or cmux extends upward into verification | Likeliest real threat. Your defence is CodeGraph depth and vendor-neutrality, not UI polish | — |

**On the prior plan's risks:** #1 terminal compatibility and #2 cross-platform PTY are now **eliminated by scope**, not mitigated. #3 plugin security is **deferred** (no plugins in v0–v2). #4 scope creep was correctly identified and is the one that will actually kill you.

---

## 10. Business model

- **Free / OSS core.** The CLI, conflict engine and local UI. This is a developer-trust product; a closed core is fatal, and Warp just demonstrated the playbook.
- **$15–25/mo Pro.** Hosted evidence bundles, shareable review links, cross-machine history, richer language coverage.
- **$40–60/user/mo Team.** Shared merge queue, org audit log, policy gates, SSO, compliance export. This is where the revenue is — the buyer is an engineering manager watching review time climb 91%, and they have budget for exactly that pain.

Deliberately *under* Warp's $50 Business, and complementary rather than competitive — you want to be the thing teams buy *in addition to* their agent stack, never the thing they have to switch to.

**GTM:** the wedge is a demo, not a description. Record one 40-second clip: five agent branches, one predicted conflict caught, four merged in ten seconds, one flagged with a reason. Post it where parallel-agent users already congregate. Then go direct to the amux/Conductor/cmux user base — they're pre-qualified: they already run fleets, so they already have the pain, and they had to go looking for these tools, which means they'll go looking for yours.

---

## 11. Is this meaningful? — honest answer

**As originally framed ("Warp + cmux + AI"): no.** It's feature aggregation against a free AGPL client with 60k stars, a YC-funded product that already shipped the exact combination, and twelve open-source tools that do the orchestration in 200 lines of bash. You'd spend 18 months to arrive at parity with things people already have for free.

**As reframed (the fan-in console): yes** — and for three specific reasons.

1. **It's a real, measured, worsening problem.** +91% review time and −19% senior throughput are not speculative. The industry has an acknowledged crisis and is currently pouring resources into making it worse.
2. **It's genuinely unoccupied.** Fifteen tools compete on fan-out. Zero compete on fan-in. That's not an oversight you should assume is wisdom — it's a category that's only ~18 months old and everyone piled into the obvious half.
3. **It's the one framing where your existing work is a moat.** CodeGraph is the wrong asset for a terminal and exactly the right asset for cross-branch semantic analysis. AgentMesh is the wrong asset for launching agents and the right one for coordinating verification. In the original plan those were nice-to-haves bolted onto a terminal; here they're the load-bearing walls.

**Research angle, if that matters to you:** "cross-branch semantic conflict prediction for concurrent AI-generated changes" is a defensible, novel, publishable contribution with a clean evaluation methodology (build a corpus of parallel agent runs, measure predicted-vs-actual post-merge breakage). "Another AI terminal" is not.

**And the honest caveat.** The one thing that could still make this a bad idea: if parallel-agent workflows turn out to be a 2026 fashion rather than a durable practice — if the industry concludes that one careful agent beats five sloppy ones — the fan-in problem shrinks with it. Watch for that. v0 is deliberately cheap and its kill criterion is deliberately sharp, because eight weeks is the right amount to spend finding out.

---

## 12. Next 90 days

| Weeks | Do | Gate |
|---|---|---|
| 1 | Build the benchmark **before** the product: 50 real parallel-agent sessions, label actual post-merge breakages | You now have a scoreboard, which most tools in this space never built |
| 2–3 | Conflict engine v0 on TypeScript: rename, signature, schema, lockfile detection | ≥80% precision on the benchmark |
| 4–5 | Risk ranking + merge-order solver + CLI | `superterminal plan` produces a correct order on 10 real repos |
| 6–8 | Local web UI, the one-screen queue | 10 external users; ≥1 "this caught something I'd have missed" |
| 9–12 | PTY capture shim, evidence bundles, claimed-vs-observed | The claimed-vs-observed badge fires correctly on a lying agent |
| 13 | **Decision point** | Kill criteria in §9. If clear — Python + Rust support, then Team mode |

**Do not write a line of terminal emulation code in these 90 days.**

---

## Sources

- [cmux — the terminal built for multitasking](https://cmux.com/)
- [Best AI Agent Multiplexers Compared (2026): 12 Tools Ranked — amux](https://amux.io/guides/best-ai-agent-multiplexers-2026/) *(vendor-published; self-ratings not neutral)*
- [cmux: a purpose-built terminal for the parallel agent workflow — ddewhurst](https://ddewhurst.com/blog/cmux-purpose-built-terminal-for-parallel-agent-workflow/)
- [cmux: The Native macOS Terminal Built for Running AI Coding Agents in Parallel — DEV](https://dev.to/arshtechpro/cmux-the-native-macos-terminal-built-for-running-ai-coding-agents-in-parallel-52il)
- [Best Multi-Agent Coding Tools for Claude Code and Codex Users (2026) — Nimbalyst](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/)
- [The Best Tools to Run Multiple Coding Agents in 2026 — agentsroom](https://agentsroom.dev/blog/best-multi-agent-coding-tools)
- [How Warp Went From Terminal to Agentic Development Environment — The New Stack](https://thenewstack.io/how-warp-went-from-terminal-to-agentic-development-environment/)
- [Warp Terminal Review 2026: Open-Source ADE, the $20 Build Plan — DEV](https://dev.to/jovan_chan_9500711396d4e6/warp-terminal-review-2026-open-source-ade-the-20-build-plan-and-who-should-actually-pay-for-it-5cin)
- [Warp Guide 2026: Agent Mode, MCP, Open Source & Deployments — DeployHQ](https://www.deployhq.com/guides/warp)
- [Modern Terminal Emulators 2026: Ghostty, WezTerm, Alacritty — Calmops](https://calmops.com/tools/modern-terminal-emulators-2026-ghostty-wezterm-alacritty/)
- [Ghostty vs Warp 2.0 vs WezTerm: Best Terminal for AI CLI in 2026 — Termdock](https://www.termdock.com/en/blog/best-terminal-emulator-ai-cli-2026)
- [Terminal & Shell Tools 2026 Deep Dive — youngju.dev](https://www.youngju.dev/blog/culture/2026-05-16-terminal-shell-tools-2026-ghostty-wezterm-alacritty-warp-fish-4-nushell-zellij-starship-deep-dive.en)
- [The Review Bottleneck: Why More AI Code Means Slower Teams in 2026 — DEV](https://dev.to/code-board/the-review-bottleneck-why-more-ai-code-means-slower-teams-in-2026-1e5n)
- [AI Coding Agent Productivity Debates: The 2026 Paradox — exceeds.ai](https://blog.exceeds.ai/ai-coding-agents-productivity-paradox/)
- [AI Code Review Is the New Bottleneck in Agentic Coding — Moderne](https://moderne.ai/blog/ai-didnt-break-coding-it-broke-code-review)
- [AI Coding Agents Move the Bottleneck to Review Queues — Developers Digest](https://www.developersdigest.tech/blog/ai-coding-agents-review-queues)
- [From Agent Traces to Trust: Evidence Tracing and Execution Provenance in LLM Agents — arXiv](https://arxiv.org/html/2606.04990v1)
- [Deterministic Replay for AI Agents: Immutable Audit Logs — agenticrail](https://agenticrail.nz/blog/ai-agent-audit-log-best-practices/)
- [Deterministic Replay: Debugging Non-Deterministic AI Agents — TianPan.co](https://tianpan.co/blog/2026-04-12-deterministic-replay-debugging-non-deterministic-ai-agents)
- [Agent Identity and Signed Provenance — Zylos Research](https://zylos.ai/research/2026-04-25-agent-identity-provenance-signed-audit-trails/)
- [7 Best AI Agent Observability Tools for Coding Teams in 2026 — Augment Code](https://www.augmentcode.com/tools/best-ai-agent-observability-tools)
