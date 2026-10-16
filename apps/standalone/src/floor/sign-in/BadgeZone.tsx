import { AcceptedIcon, BadgeIcon, PlugIcon } from "./operator-icons.js";

export type BadgeZoneState = "ready" | "unavailable" | "accepted";

export interface BadgeZoneProps {
  state: BadgeZoneState;
  title: string;
  text: string;
  /** The scanner's state in a word (a chip); while a check runs, `checking` takes its place. */
  chip: { tone: "ok" | "warn" | "error"; text: string };
  checking: string | null;
  /** The name of the operator whose badge was accepted. */
  name: string | null;
  enteringText: string;
}

/** The glyph of a chip, so that it never says its state by colour alone. */
const GLYPH = { ok: "√", warn: "!", error: "✕" } as const;

/**
 * The badge's half of the sign-in (variant A, design kit 2026-10): a picture, the one instruction,
 * and the scanner's state in a chip. One thin line passes over the badge once when the screen
 * opens (CSS, 140–740 ms) and then everything stands still. An accepted scan replaces the badge
 * with a tick in a ring and says whose it was; a scanner that does not answer says so in the
 * picture and in the words, and still points to what works.
 */
export function BadgeZone({
  state,
  title,
  text,
  chip,
  checking,
  name,
  enteringText,
}: BadgeZoneProps) {
  return (
    <section
      className="operator-login__badge"
      data-state={state}
      aria-labelledby="sign-in-badge-title"
    >
      <div className="operator-login__badge-picture">
        {state === "accepted" ? (
          <AcceptedIcon />
        ) : state === "unavailable" ? (
          <PlugIcon />
        ) : (
          <>
            <BadgeIcon />
            <span className="operator-login__sweep" aria-hidden="true" />
          </>
        )}
      </div>
      <div className="operator-login__badge-copy">
        <h2 id="sign-in-badge-title">{state === "accepted" ? (name ?? "") : title}</h2>
        <p>{state === "accepted" ? enteringText : text}</p>
      </div>
      {state !== "accepted" &&
        (checking !== null ? (
          <p className="operator-login__chip" data-tone="neutral" role="status">
            {checking}
          </p>
        ) : (
          <p className="operator-login__chip" data-testid="scanner-chip" data-tone={chip.tone}>
            <span aria-hidden="true">{GLYPH[chip.tone]}</span>
            {chip.text}
          </p>
        ))}
    </section>
  );
}
