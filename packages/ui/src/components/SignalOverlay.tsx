export type SignalTone = "ok" | "error" | "duplicate";

export interface SignalOverlayProps {
  tone: SignalTone;
  title: string;
  /** Extra line under the title — the duplicate's first-seen time. */
  detail?: string;
}

const TONE_STYLE: Record<SignalTone, { background: string; foreground: string }> = {
  ok: { background: "var(--ok-solid)", foreground: "var(--fg-on-ok-solid)" },
  error: { background: "var(--err-solid)", foreground: "var(--fg-on-err-solid)" },
  duplicate: { background: "var(--warn-solid)", foreground: "var(--fg-on-warn-solid)" },
};

export function SignalOverlay({ tone, title, detail }: SignalOverlayProps) {
  const toneStyle = TONE_STYLE[tone];
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
        background: toneStyle.background,
        color: toneStyle.foreground,
        textAlign: "center",
        padding: 32,
      }}
    >
      <SignalIcon tone={tone} />
      <span style={{ font: "var(--floor-counter-sm)", fontFamily: "var(--font-ui)" }}>{title}</span>
      {detail !== undefined && <span style={{ font: "var(--floor-lg)" }}>{detail}</span>}
    </div>
  );
}

function SignalIcon({ tone }: { tone: SignalTone }) {
  return (
    <svg
      aria-hidden="true"
      width="96"
      height="96"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="8"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {tone === "ok" ? <path d="M20 50 39 69 76 27" /> : null}
      {tone === "error" ? (
        <>
          <path d="m24 24 48 48" />
          <path d="M72 24 24 72" />
        </>
      ) : null}
      {tone === "duplicate" ? (
        <>
          <rect x="18" y="18" width="42" height="42" />
          <rect x="36" y="36" width="42" height="42" />
        </>
      ) : null}
    </svg>
  );
}
