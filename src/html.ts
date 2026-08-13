/**
 * HTML construction primitives (ADR-027).
 *
 * This module is a security boundary, not a formatting helper. Evidence bundles
 * embed agent shell commands and their captured output, and then get **sent to
 * another human**. Unescaped output is stored XSS with a delivery mechanism —
 * an agent that runs `echo '<img src=x onerror=fetch(...)>'` would otherwise get
 * script execution in a reviewer's browser, inside a document the reviewer opened
 * precisely because they were told it was trustworthy.
 *
 * So there is exactly one way to build markup here: the `html` tagged template,
 * which escapes every interpolation unless it is an already-escaped fragment.
 * Nothing in the codebase concatenates markup by hand.
 */

/** Markup that has already been escaped. The only value `html` will not re-escape. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/**
 * Escapes the five characters that can break out of text or a quoted attribute.
 * `'` and `"` are both included so a single escaper covers both contexts, which
 * removes the class of bug where a value is safe in one slot and not the other.
 */
export function escape(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

type Value = Html | string | number | boolean | null | undefined | readonly Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(String(value));
}

/** Build markup. Every `${}` is escaped unless it is an `Html` or an array of them. */
export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new Html(out);
}

/**
 * Mark a string as safe. Only for literals authored in this repository — CSS, the
 * inline script, SVG paths. Never call this on anything derived from a transcript.
 */
export function trusted(literal: string): Html {
  return new Html(literal);
}

/**
 * Embed data for the inline script. JSON alone is not enough: a `</script>` inside
 * any string ends the script element regardless of JSON quoting, and `<!--`
 * starts an HTML comment inside it. Both are reachable from agent shell output.
 */
export function jsonScriptPayload(data: unknown): Html {
  const json = JSON.stringify(data) ?? 'null';
  return new Html(json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}
