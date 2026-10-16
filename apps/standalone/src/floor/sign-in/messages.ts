import type { SignInRefusal } from "../sign-in.js";

/**
 * What the sign-in says of a check's answer, in two lines (design kit 2026-10): a title that
 * names what happened and an explanation of what to do. The sign-in screen and the re-confirm
 * dialog share the words (`floor.signIn.problems.*`), so one refusal reads the same in both.
 */
export type SignInMessage =
  | { kind: "refused"; reason: SignInRefusal; via: "pin" | "badge" }
  | { kind: "locked"; scope: "station" | "operator"; minutes: number }
  | { kind: "failed" };

export interface ProblemWords {
  /** The key of the object holding `title` and `hint`. */
  base: string;
  /** What the words fill in (`{{minutes}}`). */
  params: { minutes?: number };
  /** «not ready» is a wait, not a failure of the person at the keypad. */
  tone: "error" | "warn";
}

const PIN_REFUSAL = {
  wrong: "wrongPin",
  ambiguous: "ambiguousLogin",
  not_ready: "notReady",
  product_code: "productCode",
  layout: "layout",
  not_badge: "notBadge",
} as const satisfies Record<SignInRefusal, string>;

const BADGE_REFUSAL = {
  ...PIN_REFUSAL,
  wrong: "wrongBadge",
  ambiguous: "ambiguousBadge",
} as const satisfies Record<SignInRefusal, string>;

export function problemWords(message: SignInMessage): ProblemWords {
  const key = (name: string) => `floor.signIn.problems.${name}`;
  switch (message.kind) {
    case "failed":
      return { base: key("failed"), params: {}, tone: "error" };
    case "locked":
      return {
        base: key(message.scope === "station" ? "lockedStation" : "lockedOperator"),
        params: { minutes: message.minutes },
        tone: "error",
      };
    case "refused":
      return {
        base: key((message.via === "badge" ? BADGE_REFUSAL : PIN_REFUSAL)[message.reason]),
        params: {},
        tone: message.reason === "not_ready" ? "warn" : "error",
      };
  }
}
