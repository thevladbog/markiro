import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";
import type { CacheAge } from "../sync/worker.js";

export interface StatusStripProps {
  online: boolean;
  age: CacheAge;
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
 */
export function StatusStrip({ online, age }: StatusStripProps): React.JSX.Element {
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
    </div>
  );
}
