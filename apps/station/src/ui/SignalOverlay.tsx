export type SignalTone = "ok" | "error" | "duplicate";

export interface SignalOverlayProps {
  tone: SignalTone;
  title: string;
}

// Skeleton only: renders a full-screen colored state given a tone + title.
// The flash timing and sound are wired in 05b's signal system. Color is
// paired with the title text (color + text; icons added in 05b) per the
// color-blind-safety rule.
// Uses the same status token family as @markiro/ui (--ok-solid / --err-solid /
// --warn-solid, per Input/StatusChip) with literal hex fallbacks so the
// skeleton renders even if a token is absent.
const TONE_BG: Record<SignalTone, string> = {
  ok: "var(--ok-solid, #1f8a4c)",
  error: "var(--err-solid, #b3261e)",
  duplicate: "var(--warn-solid, #a66500)",
};

export function SignalOverlay({ tone, title }: SignalOverlayProps) {
  return (
    <div
      role="alert"
      data-tone={tone}
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: TONE_BG[tone],
        color: "#fff",
        fontSize: "4rem",
        fontWeight: 800,
        textAlign: "center",
      }}
    >
      {title}
    </div>
  );
}
