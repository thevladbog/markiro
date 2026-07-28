import { useTranslation } from "react-i18next";

export interface BlockedProps {
  /** Orders already taken that are still owed to the server. */
  queuedCount: number;
}

/**
 * What a kiosk shows once its cached dataset has aged past `STALE_BLOCK_MS`
 * (`sync/worker.ts`): it stops handing product out, because a week-old roster
 * and a week-old catalogue can no longer be trusted to say who may take what.
 *
 * The screen's real job is the third line. A blocked kiosk is not a lost
 * kiosk — the orders it already took are queued and still on their way, and
 * `flushQueue` keeps draining them whether or not anyone is standing here.
 * Without that sentence the worker's reasonable conclusion is that whatever
 * they took today has evaporated, and the administrator's first question is
 * whether to re-enter it by hand — which is how one pickup becomes two.
 *
 * The count is stated rather than described so it can be reconciled: «в
 * очереди: 4» is something an administrator can check against the panel.
 */
export function Blocked({ queuedCount }: BlockedProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <main
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 40,
        background: "var(--surface-page)",
        color: "var(--fg-1)",
      }}
    >
      {/* Decoration only — the words below carry the whole message. */}
      <svg
        width="96"
        height="96"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--warn-fg)"
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>

      {/* One live region for the whole message: a worker who walks up to an
          already-blocked kiosk needs all three sentences, not just whichever
          one changed last. */}
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          maxWidth: 720,
          textAlign: "center",
        }}
      >
        <h1 style={{ margin: 0, font: "700 36px/44px var(--font-ui)" }}>{t("blocked.title")}</h1>
        <p style={{ margin: 0, font: "400 20px/30px var(--font-ui)", color: "var(--fg-2)" }}>
          {t("blocked.body")}
        </p>
        <p
          style={{
            margin: 0,
            boxSizing: "border-box",
            padding: "16px 24px",
            borderRadius: 12,
            background: "var(--surface-card)",
            border: "1px solid var(--line)",
            font: "500 18px/26px var(--font-ui)",
            color: "var(--fg-2)",
          }}
        >
          {/* An empty queue gets its own sentence: promising that «they will
              reach the server» about nothing at all invites the worker to wait
              for a delivery that has already happened. */}
          {queuedCount > 0 ? t("blocked.queue", { n: queuedCount }) : t("blocked.queueEmpty")}
        </p>
      </div>
    </main>
  );
}
