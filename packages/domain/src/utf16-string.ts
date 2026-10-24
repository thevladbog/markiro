import { z } from "zod";

/**
 * A string of `min` to `max` UTF-16 code units: JavaScript's `length`, and the
 * unit the Rust twins of these limits count in (`markiro_proto::trust`'s
 * `utf16_len`, the host's `validate::shift_supports`).
 *
 * Zod 4.5 and later measure a string's `.min()`, `.max()` and `.length()` in
 * Unicode code points, where an astral character (an emoji) is one, so a limit
 * that must agree with Rust cannot use them: 151 emoji are 302 units but 151
 * code points, and `.max(300)` would let them through. A string out of bounds
 * gets Zod's own `too_small` / `too_big` issue, so a caller that reads issue
 * codes sees what it saw before Zod 4.5.
 */
export function utf16BoundedString(min: number, max: number) {
  return z.string().check((context) => {
    const units = context.value.length;
    if (units < min) {
      context.issues.push({
        code: "too_small",
        origin: "string",
        minimum: min,
        inclusive: true,
        input: context.value,
      });
    } else if (units > max) {
      context.issues.push({
        code: "too_big",
        origin: "string",
        maximum: max,
        inclusive: true,
        input: context.value,
      });
    }
  });
}
