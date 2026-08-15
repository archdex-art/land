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
import {
  badge,
  groupBranches,
  RISK_ORDER,
  type BranchRow,
  type Finding,
  type SessionReport,
  type Verdict,
} from './reconcile.ts';

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
  // An en dash, not a question mark. Abstention is a deliberate, correct outcome
  // and must not wear the glyph of an error; `?` read as "something went wrong"
  // on the ten of eleven branches where the honest answer is "nothing to report".
  UNKNOWN: { mark: '–', note: 'Not determinable from the transcript. Reported, never guessed.' },
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
    /* Pinned to >=4.5:1 against its own background. This carries 10.5-11.5px
       labels, which WCAG counts as normal text, so the 3:1 large-text allowance
       does not apply. Measured, not guessed: the previous pair sat at 3.49
       (dark) and 3.08 (light), and both failed AA. */
    --ink-faint:  light-dark(#6e7178, #828079);
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

  /* ---- lead: the one finding the report exists to show ------------------
     Extracted from the list entirely, the way Vercel hoists a build error out
     of the log. A reader who does nothing but look at this card has still got
     the answer. */
  .lead {
    border: 1px solid var(--contradicted);
    border-left-width: 3px;
    background: var(--panel);
    padding: var(--s4) var(--s5);
    margin-bottom: var(--s5);
    --accent: var(--contradicted);
  }
  .lead-head {
    display: flex;
    align-items: baseline;
    gap: var(--s3);
    flex-wrap: wrap;
    margin-bottom: var(--s2);
  }
  .lead-branch {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .lead-reason {
    font-size: 15px;
    margin-bottom: var(--s4);
  }

  /* ---- verdict chips ----------------------------------------------------
     The count and the filter are the same control. A tally that only reports
     is a wall of numbers; Playwright's chips let the summary *do* something. */
  .chips { display: flex; gap: var(--s1); flex-wrap: wrap; }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px var(--s2) 6px 7px;
    border: 1px solid var(--rule-firm);
    background: var(--panel);
    cursor: pointer;
    font-size: 11.5px;
    letter-spacing: 0.04em;
    color: var(--ink-dim);
    transition: border-color 140ms ease, color 140ms ease;
  }
  .chip:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-faint); }
  .chip:disabled { opacity: 0.4; cursor: default; }
  .chip-mark { color: var(--accent); font-weight: 700; }
  .chip-count {
    font-variant-numeric: tabular-nums lining-nums;
    font-weight: 600;
    color: var(--ink);
  }
  .chip[aria-pressed="true"] {
    border-color: var(--accent);
    color: var(--ink);
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  /* ---- buckets: collapse the majority that needs no action -------------- */
  .bucket {
    border: 1px solid var(--rule);
    background: var(--panel);
    margin-bottom: var(--s3);
  }
  .bucket > summary {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    flex-wrap: wrap;
    padding: var(--s3) var(--s4);
    cursor: pointer;
    list-style: none;
    color: var(--ink-dim);
  }
  .bucket > summary::-webkit-details-marker { display: none; }
  .bucket > summary:hover { background: var(--panel-2); }
  .bucket > summary b { color: var(--ink); font-weight: 600; }
  .bucket-mark { color: var(--accent); font-weight: 700; }
  .bucket-hint { color: var(--ink-faint); font-size: 11.5px; }
  .bucket > summary::after {
    content: "show";
    margin-left: auto;
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .bucket[open] > summary::after { content: "hide"; }
  .bucket .rows { padding: 0 var(--s3) var(--s3); }

  /* ---- finding head ----------------------------------------------------- */
  .finding-head {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  .scope {
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .pill {
    border: 1px solid var(--rule-firm);
    padding: 1px 6px;
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }
  .session-meta {
    display: flex;
    gap: var(--s3);
    flex-wrap: wrap;
    align-items: baseline;
    padding: var(--s2) 0 var(--s3);
    border-bottom: 1px dashed var(--rule);
    margin-bottom: var(--s4);
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .quiet { color: var(--ink-faint); padding: var(--s2) 0; }

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
    position: relative;
    margin-top: var(--s3);
    border: 1px solid var(--rule);
    background: var(--panel-2);
  }
  .copy {
    position: absolute;
    top: var(--s1);
    right: var(--s1);
    padding: 2px 7px;
    border: 1px solid var(--rule-firm);
    background: var(--panel);
    color: var(--ink-faint);
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: pointer;
    opacity: 0;
    transition: opacity 140ms ease, color 140ms ease;
  }
  /* Revealed on hover or keyboard focus — never hidden from the keyboard, which
     is what display:none-until-hover would do. */
  .evidence:hover .copy, .copy:focus-visible { opacity: 1; }
  .copy:hover { color: var(--ink); }
  .evidence .cmd {
    margin: 0;
    padding: var(--s2) var(--s3);
    font-family: var(--mono);
    font-size: 12.5px;
    /* Wrap, never clip. A command scrolled off the right edge is a command the
       reader cannot check, and the end of a pipeline is usually the part that
       decides the verdict. Continuation is indented so wrapped lines read as
       one command rather than several. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-indent: -2ch;
    padding-left: calc(var(--s3) + 2ch);
    max-height: 12lh;
    overflow-y: auto;
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
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var buckets = Array.prototype.slice.call(document.querySelectorAll('.bucket'));
  var search = document.getElementById('q');
  var count = document.getElementById('shown');
  if (!search || !count) return;

  function selected() {
    return chips.filter(function (c) { return c.getAttribute('aria-pressed') === 'true'; })
                .map(function (c) { return c.dataset.verdict; });
  }

  function apply() {
    var needle = search.value.trim().toLowerCase();
    var want = selected();
    var shown = 0;
    rows.forEach(function (row) {
      var matchesText = needle === '' || row.dataset.search.indexOf(needle) !== -1;
      var matchesVerdict = want.length === 0 || want.some(function (v) {
        return (' ' + row.dataset.verdicts + ' ').indexOf(' ' + v + ' ') !== -1;
      });
      var visible = matchesText && matchesVerdict;
      row.hidden = !visible;
      if (visible) shown++;
    });
    // A bucket whose every row is filtered out is noise; hide it, and open it
    // when a filter is active so matches inside are not hidden behind a click.
    buckets.forEach(function (b) {
      var live = Array.prototype.slice.call(b.querySelectorAll('.row')).filter(function (r) { return !r.hidden; });
      b.hidden = live.length === 0;
      if ((needle !== '' || want.length > 0) && live.length > 0) b.open = true;
    });
    count.textContent = String(shown);
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      apply();
    });
  });
  search.addEventListener('input', apply);

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

  /* Copy buttons are added here rather than rendered into the markup, so a
     reader with JavaScript disabled never meets a button that cannot work. */
  if (navigator.clipboard) {
    Array.prototype.slice.call(document.querySelectorAll('.evidence')).forEach(function (box) {
      var cmd = box.querySelector('.cmd');
      if (!cmd) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'copy';
      b.textContent = 'copy';
      b.addEventListener('click', function () {
        navigator.clipboard.writeText(cmd.textContent || '').then(function () {
          b.textContent = 'copied';
          setTimeout(function () { b.textContent = 'copy'; }, 1200);
        });
      });
      box.appendChild(b);
    });
  }

  apply();
})();
`;

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The findings a reader should actually see: worst first, duplicates collapsed.
 *
 * One sentence routinely produces several findings. "lint clean, 27 tests pass"
 * is a claim about lint *and* about tests, and the engine is right to judge each
 * separately — but a reader then meets the same sentence and the same command
 * three times in a row. Identical (verdict, sentence, evidence) triples collapse
 * into one card that names every activity it covers.
 */
interface Grouped {
  finding: Finding;
  activities: string[];
}

function digest(findings: readonly Finding[]): Grouped[] {
  const byKey = new Map<string, Grouped>();
  for (const finding of findings) {
    const key = [finding.verdict, finding.claim.sentence, finding.evidence.map((e) => e.command).join('\u0001')].join('\u0000');
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, { finding, activities: [finding.claim.activity] });
    else if (!seen.activities.includes(finding.claim.activity)) seen.activities.push(finding.claim.activity);
  }
  // Worst first. A reader who opens a CONTRADICTED branch must not have to
  // scroll past thirty verified claims to reach the one that made them open it.
  return [...byKey.values()].sort((a, b) => RISK_ORDER[a.finding.verdict] - RISK_ORDER[b.finding.verdict]);
}

/** The single finding the whole report is about, hoisted out of the list. */
function headlineFinding(rows: readonly BranchRow[]): { row: BranchRow; finding: Finding } | undefined {
  for (const row of rows) {
    if (!row.needsAttention) continue;
    const all = row.reports.flatMap((r) => r.findings);
    const worst = digest(all)[0];
    if (worst !== undefined) return { row, finding: worst.finding };
  }
  return undefined;
}

function evidenceBlock(finding: Finding): Html {
  if (finding.evidence.length === 0) return html``;
  return html`
        <p class="label">Observed</p>
        ${finding.evidence.slice(0, 3).map(
          (run) => html`<div class="evidence">
          <pre class="cmd"><code>${run.command}</code></pre>
          <div class="outcome">
            <span class="pill">${run.activity}</span>
            <span>outcome <b>${run.outcome}</b></span>
            <span>basis <b>${run.basis}</b></span>
            ${run.exitCode === null ? html`<span>exit <b>n/a</b></span>` : html`<span>exit <b>${run.exitCode}</b></span>`}
          </div>
        </div>`,
        )}`;
}

function findingBlock({ finding, activities }: Grouped): Html {
  const copy = VERDICT_COPY[finding.verdict];
  return html`
      <article class="finding" data-verdict="${finding.verdict}" style="--accent: var(--${finding.verdict.toLowerCase()})">
        <div class="finding-head">
          <span class="tag">${copy.mark}&nbsp;${finding.verdict}</span>
          ${activities.length > 1
            ? html`<span class="scope">covers ${activities.join(' · ')}</span>`
            : html`<span class="scope">${activities[0] ?? ''}</span>`}
        </div>
        <p class="reason">${finding.reason}</p>
        <p class="label">Claimed</p>
        <blockquote class="testimony">${finding.claim.sentence}</blockquote>
        ${evidenceBlock(finding)}
      </article>`;
}

function sessionBlock(report: SessionReport): Html {
  const { session } = report;
  const grouped = digest(report.findings);
  return html`
      <div class="session-meta">
        <span class="pill">session ${session.id.slice(0, 8)}</span>
        <span>${fmt(session.execs.length)} shell invocations</span>
        <span>${fmt(report.runs.length)} classified runs</span>
        <span>${fmt(session.edits.length)} file edits</span>
        ${session.models.length === 0 ? '' : html`<span>${session.models.join(', ')}</span>`}
      </div>
      ${grouped.map(findingBlock)}`;
}

function branchRow(row: BranchRow): Html {
  const copy = VERDICT_COPY[row.verdict];
  const haystack = `${row.label} ${row.summary} ${row.verdict}`.toLowerCase();
  const findings = row.reports.reduce((n, r) => n + r.findings.length, 0);
  /*
   * Every verdict present in the branch, not just its worst. The chips count
   * *claims*, so a chip reading "verified 84" must match the branches those 84
   * claims live in — matching on worst-verdict alone would have made that chip
   * select nothing at all, which is the same lie the old "Verified 0" tally told.
   */
  const present = [...new Set(row.reports.flatMap((r) => r.findings.map((f) => f.verdict)))];
  return html`
    <details class="row" data-verdicts="${[row.verdict, ...present].join(' ')}"
      style="--accent: var(--${row.verdict.toLowerCase()})"
      data-search="${haystack}" data-attention="${row.needsAttention ? '1' : '0'}">
      <summary>
        <span class="mark" aria-hidden="true">${copy.mark}</span>
        <span class="branch" title="${row.label}">${row.label}<span class="sr-only"> — ${row.verdict}</span></span>
        <span class="summary-text">${row.summary}</span>
        <span class="facts">${fmt(row.execs)} cmd · ${fmt(row.edits)} edit</span>
      </summary>
      <div class="findings">
        ${findings === 0
          ? html`<p class="quiet">This branch's sessions made no execution claims, so there is nothing to verify.</p>`
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

  /*
   * Buckets, not one flat list. On a real corpus 10 of 11 branches are UNKNOWN —
   * nothing a reader can act on — and a flat list buries the single branch that
   * matters under ten that do not. Lighthouse and GitHub both solve this by
   * collapsing the uninteresting majority behind a disclosure with a count.
   */
  const settled = rows.filter((r) => !r.needsAttention);
  const verifiedRows = settled.filter((r) => r.verdict === 'VERIFIED');
  const quietRows = settled.filter((r) => r.verdict !== 'VERIFIED');

  // The one finding the report exists to show, lifted out of the list entirely.
  const lead = headlineFinding(rows);

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

  ${lead === undefined
    ? html``
    : html`<section class="lead" aria-label="The finding to read first">
        <div class="lead-head">
          <span class="tag">${VERDICT_COPY[lead.finding.verdict].mark}&nbsp;${lead.finding.verdict}</span>
          <span class="lead-branch">${lead.row.label}</span>
        </div>
        <p class="lead-reason">${lead.finding.reason}</p>
        <p class="label">The agent wrote</p>
        <blockquote class="testimony">${lead.finding.claim.sentence}</blockquote>
        ${evidenceBlock(lead.finding)}
      </section>`}

  <div class="controls">
    <input id="q" type="search" placeholder="Filter branches…  (press /)" aria-label="Filter branches">
    <div class="chips" role="group" aria-label="Filter by verdict">
      ${VERDICT_ORDER.map((v) => {
        const n = findings.filter((f) => f.verdict === v).length;
        return html`<button class="chip" type="button" data-verdict="${v}" aria-pressed="false"
          style="--accent: var(--${v.toLowerCase()})" ${n === 0 ? trusted('disabled') : ''}>
          <span class="chip-mark" aria-hidden="true">${VERDICT_COPY[v].mark}</span>
          <span class="chip-label">${v.toLowerCase()}</span>
          <span class="chip-count">${fmt(n)}</span>
        </button>`;
      })}
    </div>
    <span class="facts"><span id="shown">${fmt(rows.length)}</span> of ${fmt(rows.length)} branches</span>
  </div>

  <div class="rows" id="rows">
    ${rows.length === 0 ? html`<p class="empty">No agent sessions were found for this repository.</p>` : ''}
    ${attention.map(branchRow)}
  </div>

  ${verifiedRows.length === 0
    ? html``
    : html`<details class="bucket">
        <summary>
          <span class="bucket-mark" style="--accent: var(--verified)">${VERDICT_COPY['VERIFIED'].mark}</span>
          <b>${fmt(verifiedRows.length)}</b> ${verifiedRows.length === 1 ? 'branch is' : 'branches are'} fully verified
          <span class="bucket-hint">every claim backed by an observed run</span>
        </summary>
        <div class="rows">${verifiedRows.map(branchRow)}</div>
      </details>`}

  ${quietRows.length === 0
    ? html``
    : html`<details class="bucket">
        <summary>
          <span class="bucket-mark" style="--accent: var(--unknown)">${VERDICT_COPY['UNKNOWN'].mark}</span>
          <b>${fmt(quietRows.length)}</b> ${quietRows.length === 1 ? 'branch' : 'branches'} made no verifiable claim
          <span class="bucket-hint">nothing was asserted, or the transcript cannot settle it</span>
        </summary>
        <div class="rows">${quietRows.map(branchRow)}</div>
      </details>`}

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
