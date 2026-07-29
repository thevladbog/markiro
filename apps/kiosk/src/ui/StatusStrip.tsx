import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";
import type { CacheAge } from "../sync/worker.js";

export interface StatusStripProps {
  online: boolean;
  age: CacheAge;
  /**
   * Orders the server refused for good and the device has set aside
   * (`store/queue.ts`'s quarantine store).
   *
   * REQUIRED, and deliberately not an optional that defaults to zero. A
   * quarantined order is invisible everywhere else on this device — it has left
   * the queue, so `Blocked`'s count no longer covers it, and it will never be
   * retried — so the strip is the only thing standing between it and nobody
   * ever knowing. An optional prop is exactly how that silence gets
   * reintroduced: a later call site that simply forgets to pass it type-checks,
   * renders, and says nothing.
   */
  quarantined: number;
}

/**
 * The persistent honesty strip: whether the kiosk can currently reach the
 * server, and whether the dataset it is deciding from is still young.
 *
 * The two are deliberately separate signals. A kiosk can be online with a
 * stale snapshot (the refresh keeps failing on the server's side) or offline
 * with a fresh one (the network dropped a minute ago), and collapsing them
 * into one indicator would make the commonest support question — «is it the
 * network or the data?» — unanswerable from the screen.
 *
 * The staleness warning shows for `blocked` as well as `warn`. `blocked` is
 * strictly worse than a day old, so staying silent there would be the strip
 * quietly asserting freshness at the exact moment it is least true. The
 * `Blocked` screen states the consequence; this only states the fact.
 *
 * The quarantine line is a THIRD independent signal for the same reason, and
 * the one that is nobody's fault here: it says nothing about the network and
 * nothing about the data's age — a kiosk can be online, fresh and still be
 * holding an order the server will never take.
 */
export function StatusStrip({ online, age, quarantined }: StatusStripProps): React.JSX.Element {
  const { t } = useTranslation();

  // Kiosk-sized: `StatusChip`'s office default is 24px tall with 12px type,
  // which is unreadable at the distance someone stands from a wall-mounted
  // tablet. `StatusChip` spreads `style` over its own, so this is an override
  // rather than a fork.
  const chip = { height: 40, padding: "0 16px", font: "600 16px/1 var(--font-ui)" } as const;

  return (
    <div
      role="status"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        // The third chip is what makes this necessary: «Нет связи…» beside
        // «Сервер отклонил заявки: …» is wider than a portrait tablet, and
        // `StatusChip` sets `whiteSpace: nowrap`, so without a wrap the last
        // signal added is the one that runs off the edge of the screen.
        flexWrap: "wrap",
        padding: "10px 24px",
        background: "var(--surface-card)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      {/* StatusChipProps omits `children`, so the copy goes through `label`. */}
      <StatusChip
        status={online ? "ok" : "warn"}
        label={online ? t("status.online") : t("status.offline")}
        style={chip}
      />
      {age !== "fresh" ? <StatusChip status="warn" label={t("status.stale")} style={chip} /> : null}
      {/* ONLY when there is one. A permanent «отклонил: 0» would teach everyone
          who walks past this kiosk to read straight through the line, on the
          day it finally has something to say.

          `warn` rather than `error`, and the copy names the administrator:
          nothing the worker standing here can do clears this, and a red chip
          on an otherwise healthy kiosk would have them abandon a pickup that
          is working perfectly. The COUNT is stated rather than described so an
          administrator can reconcile it against the panel, the way `Blocked`
          states its queue. Deliberately not an i18next plural: the RU
          categories (`_one/_few/_many/_other`) have no EN counterpart and the
          lockstep test requires identical key sets in both files. */}
      {quarantined > 0 ? (
        <StatusChip
          status="warn"
          label={t("status.quarantined", { n: quarantined })}
          style={chip}
        />
      ) : null}
    </div>
  );
}
