/**
 * Self-contained HTML evidence report (ADR-026, ADR-027, ADR-028).
 *
 * One document, no external references of any kind: no fonts, no scripts, no
 * images, no stylesheets, no analytics. It opens from a `file://` URL, offline,
 * on a machine that has never heard of this project — which is the requirement
 * for `F-030`, sending a reviewer proof rather than a diff.
 *
 * The aesthetic is a court exhibit rather than a dashboard. What the agent
 * *said* is set in serif, as testimony. What was *observed* is set in monospace,
 * as evidence. The two are never visually confusable, which is the whole point
 * of the product rendered as a typographic rule.
 */

import { escape, html, jsonScriptPayload, trusted, type Html } from './html.ts';
import { badge, groupBranches, type BranchRow, type Finding, type SessionReport, type Verdict } from './reconcile.ts';

export interface ReportMeta {
  repo: string;
  generatedAt: string;
  /** Evidence-chain head, when the report was produced from a store. */
  chainHead?: string | undefined;
  version: string;
}

const VERDICT_COPY: Record<Verdict, { mark: string; note: string }> = {
  CONTRADICTED: { mark: '✕', note: 'The agent claimed success. The run it refers to failed.' },
  UNSUPPORTED: { mark: '!', note: 'The agent claimed it. No such command was ever run.' },
  UNKNOWN: { mark: '?', note: 'Not determinable from the transcript. Reported, never guessed.' },
  VERIFIED: { mark: '✓', note: 'Backed by an observed run that succeeded.' },
};

/** Severity order, for the legend. Declared rather than derived from key order. */
const VERDICT_ORDER = ['CONTRADICTED', 'UNSUPPORTED', 'UNKNOWN', 'VERIFIED'] as const satisfies readonly Verdict[];

/*
 * Design tokens.
 *
 * Near-monochrome by intent: the verdict is the only saturated colour on screen,
 * so a red row is impossible to miss in peripheral vision. Backgrounds avoid pure
 * black (OLED smear, and it reads as "terminal" rather than "document").
 * Every accent was checked against its background for AA contrast at body size.
 */
const CSS = String.raw`
@layer reset, base, layout, components, print;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  body, h1, h2, h3, p, figure, blockquote, ol, ul { margin: 0; padding: 0; }
  ul { list-style: none; }
  button { font: inherit; color: inherit; background: none; border: none; }
}

@layer base {
  :root {
    color-scheme: dark light;

    --ink:        light-dark(#16181c, #e9e6e1);
    --ink-dim:    light-dark(#5c5f66, #97948e);
    --ink-faint:  light-dark(#8a8d94, #6a6862);
    --bg:         light-dark(#f7f6f4, #0c0d0f);
    --panel:      light-dark(#ffffff, #131417);
    --panel-2:    light-dark(#f1efec, #191a1e);
    --rule:       light-dark(#00000018, #ffffff14);
    --rule-firm:  light-dark(#00000030, #ffffff26);
    --grid:       light-dark(#0000000a, #ffffff08);

    --contradicted: light-dark(#c1352a, #ff6f5e);
    --unsupported:  light-dark(#8a6100, #f2b13c);
    --unknown:      light-dark(#2f6d8c, #74b2d0);
    --verified:     light-dark(#2f6b46, #74c295);

    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;

    /* Dense scale: this is a triage document, not a marketing page. */
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  }

  html { -webkit-text-size-adjust: 100%; }

  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 13.5px;
    line-height: 1.55;
    font-variant-numeric: tabular-nums;
    /* Graph paper, at the threshold of visibility. It gives the page the
       texture of a measurement surface without competing with the content;
       at full --rule strength the vertical lines cut through the masthead. */
    background-image:
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 128px 128px, 128px 128px;
    background-attachment: fixed;
  }

  a { color: inherit; }

  :focus-visible {
    outline: 2px solid var(--unknown);
    outline-offset: 2px;
    border-radius: 2px;
  }

  ::selection { background: light-dark(#00000018, #ffffff26); }

  /* Verdict is carried by colour, a mark, and text. This is the text, for
     screen readers and for anyone who cannot distinguish the accent hues. */
  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
}

@layer layout {
  .sheet {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--s7) var(--s5) var(--s7);
  }

  @media (max-width: 640px) {
    .sheet { padding: var(--s5) var(--s4); }
  }
}

@layer components {
  /* ---- masthead ------------------------------------------------------- */
  .masthead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s4);
    padding-bottom: var(--s3);
    border-bottom: 1px solid var(--rule-firm);
    flex-wrap: wrap;
  }
  .wordmark {
    font-size: 12px;
    letter-spacing: 0.42em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .wordmark::after {
    content: "";
    display: inline-block;
    width: 5px; height: 5px;
    margin-left: -0.3em;
    background: var(--ink);
    vertical-align: 0.08em;
  }
  .masthead .kicker {
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }

  /* ---- the decision --------------------------------------------------- */
  .verdict-head { padding: var(--s6) 0 var(--s5); }
  .verdict-head h1 {
    font-family: var(--serif);
    font-size: clamp(28px, 5.2vw, 46px);
    line-height: 1.08;
    letter-spacing: -0.015em;
    font-weight: 400;
    text-wrap: balance;
  }
  .verdict-head h1 em {
    font-style: normal;
    /* The one place a colour is allowed to be loud. */
    color: var(--accent, var(--ink));
    border-bottom: 2px solid currentColor;
    padding-bottom: 0.04em;
  }
  .verdict-head p {
    margin-top: var(--s3);
    max-width: 62ch;
    color: var(--ink-dim);
    font-family: var(--sans);
    font-size: 14px;
  }

  /* ---- tally ---------------------------------------------------------- */
  .tally {
    display: flex;
    flex-wrap: wrap;
    gap: 1px;
    background: var(--rule);
    border: 1px solid var(--rule);
    margin-bottom: var(--s6);
  }
  .tally div {
    flex: 1 1 120px;
    background: var(--panel);
    padding: var(--s3) var(--s4);
  }
  .tally dt {
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .tally dd {
    font-size: 26px;
    line-height: 1.1;
    margin-top: 2px;
    font-variant-numeric: tabular-nums lining-nums;
  }
  .tally dd.hot { color: var(--accent); }

  /* ---- controls ------------------------------------------------------- */
  .controls {
    display: flex;
    gap: var(--s2);
    align-items: center;
    margin-bottom: var(--s3);
    flex-wrap: wrap;
  }
  .controls input {
    flex: 1 1 220px;
    min-width: 0;
    font: inherit;
    color: inherit;
    background: var(--panel);
    border: 1px solid var(--rule-firm);
    padding: 7px var(--s3);
  }
  .controls input::placeholder { color: var(--ink-faint); }
  .controls button {
    border: 1px solid var(--rule-firm);
    background: var(--panel);
    padding: 7px var(--s3);
    cursor: pointer;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-dim);
    transition: color 160ms ease, border-color 160ms ease;
  }
  .controls button:hover { color: var(--ink); border-color: var(--ink-faint); }
  .controls button[aria-pressed="true"] {
    color: var(--bg);
    background: var(--ink);
    border-color: var(--ink);
  }

  /* ---- branch rows ---------------------------------------------------- */
  .rows { border-top: 1px solid var(--rule-firm); }

  .row {
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
    /* The verdict bar. Colour plus a mark, never colour alone. */
    border-left: 3px solid var(--accent);
  }
  .row[hidden] { display: none; }

  .row > summary {
    display: grid;
    /* Sizing the branch column to content, capped by the row, so long names
       truncate with an ellipsis instead of breaking mid-path — which turned
       Action_classification/HEAD into two unreadable lines. */
    grid-template-columns: 1.6em minmax(0, auto) minmax(12ch, 1fr) auto;
    gap: var(--s3);
    align-items: baseline;
    padding: var(--s3) var(--s4);
    cursor: pointer;
    list-style: none;
    transition: background 160ms ease;
  }
  .row > summary::-webkit-details-marker { display: none; }
  .row > summary:hover { background: var(--panel-2); }

  .mark {
    color: var(--accent);
    font-weight: 700;
    text-align: center;
  }
  .branch {
    font-weight: 600;
    max-width: 34ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary-text {
    color: var(--ink-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .facts {
    color: var(--ink-faint);
    font-size: 11.5px;
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .row > summary { grid-template-columns: 1.6em minmax(0, 1fr); }
    .summary-text, .facts { grid-column: 2; }
  }

  /* ---- findings ------------------------------------------------------- */
  .findings { padding: 0 var(--s4) var(--s4) calc(1.6em + var(--s4) + var(--s3)); }
  @media (max-width: 760px) { .findings { padding-left: var(--s4); } }

  .finding {
    border-top: 1px dashed var(--rule-firm);
    padding: var(--s4) 0 var(--s2);
  }
  .finding > .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid currentColor;
    padding: 1px 7px;
  }
  .reason {
    font-family: var(--sans);
    margin-top: var(--s2);
    color: var(--ink);
  }

  /* Testimony: what the agent said. Serif, indented, quoted. */
  .testimony {
    font-family: var(--serif);
    font-size: 16.5px;
    line-height: 1.5;
    margin-top: var(--s3);
    padding-left: var(--s4);
    border-left: 2px solid var(--rule-firm);
    color: var(--ink);
    text-wrap: pretty;
  }
  .testimony::before { content: "\201C"; }
  .testimony::after  { content: "\201D"; }

  /* Evidence: what actually ran. Monospace, boxed, machine-flavoured. */
  .evidence {
    margin-top: var(--s3);
    border: 1px solid var(--rule);
    background: var(--panel-2);
  }
  .evidence .cmd {
    padding: var(--s2) var(--s3);
    overflow-x: auto;
    white-space: pre;
    font-size: 12.5px;
  }
  .evidence .outcome {
    display: flex;
    gap: var(--s3);
    flex-wrap: wrap;
    border-top: 1px solid var(--rule);
    padding: 5px var(--s3);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .evidence .outcome b { font-weight: 600; color: var(--ink-dim); }
  .label {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-top: var(--s3);
  }

  .empty {
    padding: var(--s5) var(--s4);
    color: var(--ink-faint);
    font-family: var(--sans);
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
  }

  /* ---- provenance ----------------------------------------------------- */
  .provenance {
    margin-top: var(--s6);
    padding-top: var(--s3);
    border-top: 1px solid var(--rule-firm);
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2) var(--s5);
    font-size: 11px;
    color: var(--ink-faint);
  }
  .provenance b { font-weight: 600; color: var(--ink-dim); }
  .provenance code { overflow-wrap: anywhere; }

  .legend {
    margin-top: var(--s5);
    display: grid;
    gap: var(--s2);
    font-size: 11.5px;
    color: var(--ink-faint);
    font-family: var(--sans);
  }
  .legend span { color: var(--accent); font-family: var(--mono); font-weight: 700; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0ms !important; animation-duration: 0ms !important; }
}

@layer print {
  @media print {
    :root { color-scheme: light; }
    body { background: #fff; color: #000; background-image: none; font-size: 10pt; }
    .controls { display: none; }
    .row { break-inside: avoid; border-left-width: 2px; }
    .row[hidden] { display: block !important; }
    details { open: true; }
    .findings { display: block !important; }
  }
}
`;

/*
 * Filtering and keyboard navigation. Deliberately small: the document is fully
 * usable with JavaScript disabled — `<details>` handles disclosure natively and
 * every row is present in the markup. This only adds triage convenience.
 */
const JS = String.raw`
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
  var search = document.getElementById('q');
  var only = document.getElementById('only');
  var count = document.getElementById('shown');

  function apply() {
    var needle = search.value.trim().toLowerCase();
    var attentionOnly = only.getAttribute('aria-pressed') === 'true';
    var shown = 0;
    rows.forEach(function (row) {
      var matchesText = needle === '' || row.dataset.search.indexOf(needle) !== -1;
      var matchesFilter = !attentionOnly || row.dataset.attention === '1';
      var visible = matchesText && matchesFilter;
      row.hidden = !visible;
      if (visible) shown++;
    });
    count.textContent = String(shown);
  }

  search.addEventListener('input', apply);
  only.addEventListener('click', function () {
    only.setAttribute('aria-pressed', only.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    apply();
  });

  document.addEventListener('keydown', function (e) {
    if (e.target === search) {
      if (e.key === 'Escape') { search.value = ''; apply(); search.blur(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); search.focus(); return; }
    if (e.key === 'e') {
      var open = rows.some(function (r) { return r.open; });
      rows.forEach(function (r) { if (!r.hidden) r.open = !open; });
    }
  });

  apply();
})();
`;

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function evidenceBlock(finding: Finding): Html {
  if (finding.evidence.length === 0) return html``;
  return html`
        <p class="label">Observed</p>
        ${finding.evidence.slice(0, 3).map(
          (run) => html`<div class="evidence">
          <div class="cmd">${run.command}</div>
          <div class="outcome">
            <span><b>${run.activity}</b></span>
            <span>outcome <b>${run.outcome}</b></span>
            <span>basis <b>${run.basis}</b></span>
            ${run.exitCode === null ? html`<span>exit <b>n/a</b></span>` : html`<span>exit <b>${run.exitCode}</b></span>`}
          </div>
        </div>`,
        )}`;
}

function findingBlock(finding: Finding): Html {
  const copy = VERDICT_COPY[finding.verdict];
  return html`
      <article class="finding" style="--accent: var(--${finding.verdict.toLowerCase()})">
        <span class="tag">${copy.mark}&nbsp;${finding.verdict}</span>
        <p class="reason">${finding.reason}</p>
        <p class="label">Claimed</p>
        <blockquote class="testimony">${finding.claim.sentence}</blockquote>
        ${evidenceBlock(finding)}
      </article>`;
}

function sessionBlock(report: SessionReport): Html {
  const { session } = report;
  const b = badge(report);
  return html`
      <div class="finding" style="--accent: var(--${b.verdict.toLowerCase()})">
        <span class="tag">session ${session.id.slice(0, 8)}</span>
        <p class="reason">
          ${fmt(session.execs.length)} shell invocations · ${fmt(report.runs.length)} classified runs ·
          ${fmt(session.edits.length)} file edits · ${fmt(session.usage.inputTokens + session.usage.outputTokens)} tokens
          ${session.models.length === 0 ? '' : ` · ${session.models.join(', ')}`}
        </p>
      </div>
      ${report.findings.map(findingBlock)}`;
}

function branchRow(row: BranchRow): Html {
  const copy = VERDICT_COPY[row.verdict];
  const haystack = `${row.label} ${row.summary} ${row.verdict}`.toLowerCase();
  const findings = row.reports.reduce((n, r) => n + r.findings.length, 0);
  return html`
    <details class="row" style="--accent: var(--${row.verdict.toLowerCase()})"
      data-search="${haystack}" data-attention="${row.needsAttention ? '1' : '0'}">
      <summary>
        <span class="mark" aria-hidden="true">${copy.mark}</span>
        <span class="branch">${row.label}<span class="sr-only"> — ${row.verdict}</span></span>
        <span class="summary-text">${row.summary}</span>
        <span class="facts">${fmt(row.execs)} cmd · ${fmt(row.edits)} edit · ${fmt(row.tokens)} tok</span>
      </summary>
      <div class="findings">
        ${findings === 0
          ? html`<p class="reason" style="color: var(--ink-faint)">No execution claims were made in this branch's sessions.</p>`
          : row.reports.map(sessionBlock)}
      </div>
    </details>`;
}

/** Render the complete, self-contained report document. */
export function renderReport(reports: SessionReport[], meta: ReportMeta): string {
  const rows = groupBranches(reports);
  const attention = rows.filter((r) => r.needsAttention);
  // Counted over *claims*, not branches. Tallying branches by their worst
  // verdict reported "Verified 0" on a corpus with 84 verified claims, because
  // no branch's worst verdict happened to be VERIFIED — technically true and
  // completely misleading, in the one place a reader looks for a summary.
  const findings = reports.flatMap((r) => r.findings);
  const tally = {
    branches: rows.length,
    claims: findings.length,
    contradicted: findings.filter((f) => f.verdict === 'CONTRADICTED').length,
    unsupported: findings.filter((f) => f.verdict === 'UNSUPPORTED').length,
    unknown: findings.filter((f) => f.verdict === 'UNKNOWN').length,
    verified: findings.filter((f) => f.verdict === 'VERIFIED').length,
  };
  const worst = rows[0]?.verdict ?? 'VERIFIED';

  const headline =
    attention.length === 0
      ? html`<h1>Nothing here is <em>overstating</em> its work.</h1>
          <p>
            Every execution claim across ${fmt(rows.length)} branches is either backed by an observed run or
            explicitly marked unverifiable. No branch is claiming a command it never ran.
          </p>`
      : html`<h1>Read <em>${attention[0]!.label}</em> first.</h1>
          <p>
            ${attention.length === 1 ? 'One branch' : `${fmt(attention.length)} branches`} of ${fmt(rows.length)}
            ${attention.length === 1 ? 'makes' : 'make'} an execution claim the transcript does not support. The rest
            are either verified or honestly marked unverifiable.
          </p>`;

  // Only the document title needs to reach the tab strip; nothing else escapes.
  const title = attention.length === 0 ? 'land — no unsupported claims' : `land — read ${attention[0]!.label} first`;

  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<title>${title}</title>
<style>${trusted(CSS)}</style>
</head>
<body>
<main class="sheet" style="--accent: var(--${worst.toLowerCase()})">

  <header class="masthead">
    <span class="wordmark">land</span>
    <span class="kicker">Execution evidence · ${meta.repo}</span>
  </header>

  <section class="verdict-head">${headline}</section>

  <dl class="tally">
    <div><dt>Branches</dt><dd>${fmt(tally.branches)}</dd></div>
    <div><dt>Claims made</dt><dd>${fmt(tally.claims)}</dd></div>
    <div><dt>Contradicted</dt><dd class="${tally.contradicted > 0 ? 'hot' : ''}"
      style="--accent: var(--contradicted)">${fmt(tally.contradicted)}</dd></div>
    <div><dt>Unsupported</dt><dd class="${tally.unsupported > 0 ? 'hot' : ''}"
      style="--accent: var(--unsupported)">${fmt(tally.unsupported)}</dd></div>
    <div><dt>Unverifiable</dt><dd>${fmt(tally.unknown)}</dd></div>
    <div><dt>Verified</dt><dd style="--accent: var(--verified)"
      class="${tally.verified > 0 ? 'hot' : ''}">${fmt(tally.verified)}</dd></div>
  </dl>

  <div class="controls">
    <input id="q" type="search" placeholder="Filter branches…  (press /)" aria-label="Filter branches">
    <button id="only" type="button" aria-pressed="false">Needs attention</button>
    <span class="facts"><span id="shown">${fmt(rows.length)}</span> shown</span>
  </div>

  <div class="rows">
    ${rows.length === 0
      ? html`<p class="empty">No agent sessions were found for this repository.</p>`
      : rows.map(branchRow)}
  </div>

  <div class="legend">
    ${VERDICT_ORDER.map(
      (v) =>
        html`<div style="--accent: var(--${v.toLowerCase()})">
          <span>${VERDICT_COPY[v].mark} ${v}</span> — ${VERDICT_COPY[v].note}
        </div>`,
    )}
  </div>

  <footer class="provenance">
    <span><b>Generated</b> ${meta.generatedAt}</span>
    <span><b>Repository</b> ${meta.repo}</span>
    <span><b>land</b> ${meta.version}</span>
    ${meta.chainHead === undefined ? '' : html`<span><b>Chain head</b> <code>${meta.chainHead}</code></span>`}
    <span>Secrets redacted before write. This document makes no network requests.</span>
  </footer>

</main>
<script>${trusted(JS)}</script>
</body>
</html>
`;

  return doc.value;
}

/** Escape helper re-exported for the CLI's own small needs. */
export { escape };

/** Payload embedding is available for a future interactive view. */
export { jsonScriptPayload };
