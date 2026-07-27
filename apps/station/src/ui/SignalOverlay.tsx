export type SignalTone = "ok" | "error" | "duplicate";

export interface SignalOverlayProps {
  tone: SignalTone;
  title: string;
  /** Extra line under the title — the duplicate's first-seen time. */
  detail?: string;
}

// Renders a full-screen colored state given a tone + title, driven by
// WorkScreen's signal system (flash timing in FLASH_MS, sound in
// playSignalTone). Color is paired with the title text per the
// color-blind-safety rule (no color-only signal).
// Uses the same status token family as @markiro/ui (--ok-solid / --err-solid /
// --warn-solid, per Input/StatusChip) with literal hex fallbacks so the
// overlay still renders correctly even if a token is absent.
const TONE_BG: Record<SignalTone, string> = {
  ok: "var(--ok-solid, #1f8a4c)",
  error: "var(--err-solid, #b3261e)",
  duplicate: "var(--warn-solid, #a66500)",
};

export function SignalOverlay({ tone, title, detail }: SignalOverlayProps) {
  return (
    <div
      role="alert"
      data-tone={tone}
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        alignContent: "center",
        gap: 16,
        background: TONE_BG[tone],
        color: "#fff",
        textAlign: "center",
        padding: 32,
      }}
    >
      <span style={{ fontSize: "4rem", fontWeight: 800 }}>{title}</span>
      {detail !== undefined && <span style={{ fontSize: "1.75rem" }}>{detail}</span>}
    </div>
  );
}
