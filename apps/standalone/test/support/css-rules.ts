/**
 * A small CSS tokenizer for the stylesheet contract tests: every style rule with its selector
 * list and declaration block, descending into `@media`, `@container`, `@supports` and `@layer`
 * blocks, skipping `@keyframes` steps and `@font-face`-like declaration-only at-rules.
 *
 * The test used to match selectors with `(^|\})\s*([^{}@]+)\{`: that regex consumes the closing
 * brace of the previous rule, so every second rule of a stylesheet was never looked at.
 */
export interface CssRule {
  /** The selector list as written, whitespace collapsed. */
  selector: string;
  /** The declarations between the braces (no nested rules). */
  body: string;
  /** The at-rules the rule sits in, outermost first (`@media (max-width: 1100px)`). */
  within: string[];
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const NESTING_AT_RULES = /^@(media|container|supports|layer|document)\b/;

export function cssRules(source: string): CssRule[] {
  const css = stripCssComments(source);
  const rules: CssRule[] = [];

  function block(from: number, within: string[]): number {
    let index = from;
    let prelude = "";
    while (index < css.length) {
      const char = css[index] as string;
      if (char === "}") return index + 1;
      if (char === ";") {
        prelude = "";
        index += 1;
        continue;
      }
      if (char !== "{") {
        prelude += char;
        index += 1;
        continue;
      }
      const head = prelude.replace(/\s+/g, " ").trim();
      if (head.startsWith("@")) {
        if (NESTING_AT_RULES.test(head)) {
          index = block(index + 1, [...within, head]);
        } else {
          index = skipBlock(index + 1);
        }
      } else {
        const end = skipBlock(index + 1);
        rules.push({ selector: head, body: css.slice(index + 1, end - 1).trim(), within });
        index = end;
      }
      prelude = "";
    }
    return index;
  }

  function skipBlock(from: number): number {
    let depth = 1;
    let index = from;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      index += 1;
    }
    return index;
  }

  block(0, []);
  return rules;
}

/** The comma-separated parts of a selector list, not splitting inside `()` (`:where(a, b)`, `:is(...)`). */
export function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}
