/**
 * Tests for the HTML security boundary (html.ts).
 *
 * Agent shell output is the single most dangerous interpolation site: an agent
 * that runs `echo '<img src=x onerror=alert(1)>'` would get script execution
 * in a reviewer's browser if escaping ever silently regresses. These tests
 * encode the contract: every path from transcript data to rendered markup
 * either escapes or explicitly marks safe, and nothing else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, escape, trusted, jsonScriptPayload, Html } from '../src/html.ts';

test('escape covers all five breakout characters', () => {
  assert.equal(escape('&'), '&amp;');
  assert.equal(escape('<'), '&lt;');
  assert.equal(escape('>'), '&gt;');
  assert.equal(escape('"'), '&quot;');
  assert.equal(escape("'"), '&#39;');
  assert.equal(
    escape(`<script>alert("xss")</script>`),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
  );
});

test('escape leaves ordinary text untouched', () => {
  const normal = 'All 42 tests pass in 1.3s';
  assert.equal(escape(normal), normal);
});

test('html template escapes string interpolations', () => {
  const payload = '<img src=x onerror=fetch("//evil.com")>';
  const result = html`<p>${payload}</p>`;
  assert.ok(result instanceof Html);
  assert.ok(!result.value.includes('<img'));
  assert.ok(result.value.includes('&lt;img'));
});

test('html template does not double-escape Html values', () => {
  const inner = html`<em>safe</em>`;
  const outer = html`<p>${inner}</p>`;
  assert.equal(outer.value, '<p><em>safe</em></p>');
});

test('html template escapes numbers and coerces falsy values', () => {
  assert.equal(html`<dd>${42}</dd>`.value, '<dd>42</dd>');
  assert.equal(html`${null}`.value, '');
  assert.equal(html`${undefined}`.value, '');
  assert.equal(html`${false}`.value, '');
  assert.equal(html`${true}`.value, '');
});

test('html template flattens arrays and escapes each element', () => {
  const items = ['<b>one</b>', html`<b>two</b>`];
  const result = html`<ul>${items}</ul>`;
  assert.ok(result.value.includes('&lt;b&gt;one&lt;/b&gt;'));
  assert.ok(result.value.includes('<b>two</b>'));
});

test('trusted bypasses escaping (only for authored literals)', () => {
  const css = 'body { color: red; }';
  const result = html`<style>${trusted(css)}</style>`;
  assert.equal(result.value, '<style>body { color: red; }</style>');
});

test('jsonScriptPayload neutralises </script> and <!-- inside JSON', () => {
  const data = { output: '</script><script>alert(1)</script>', comment: '<!-- injected -->' };
  const payload = jsonScriptPayload(data);
  assert.ok(payload instanceof Html);
  assert.ok(!payload.value.includes('</script>'), 'must not contain literal </script>');
  assert.ok(!payload.value.includes('<!--'), 'must not contain literal <!--');
  // The escaped form should be parseable back to the original data
  const roundtrip = JSON.parse(payload.value.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
  assert.deepEqual(roundtrip, data);
});

test('attribute injection is neutralised by quote escaping', () => {
  const malicious = '" onmouseover="alert(1)" data-x="';
  const result = html`<div title="${malicious}">safe</div>`;
  // The injected `"` that would break out of the attribute is escaped to `&quot;`,
  // so the browser sees a single attribute value, not three separate attributes.
  // The string "onmouseover" is still present as text, but never as an attribute name.
  assert.ok(result.value.includes('&quot;'));
  assert.ok(!result.value.includes('title="" onmouseover='));
  assert.equal(
    result.value,
    '<div title="&quot; onmouseover=&quot;alert(1)&quot; data-x=&quot;">safe</div>',
  );
});
