import { useTranslation } from "react-i18next";

import { Alert, Card, EmptyState, PageHeader, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { useChannels, type ChannelState, type ChannelSummaryDto } from "./api.js";

/**
 * State -> chip color, one-to-one with the five `ChannelState` values
 * (brief 08's "not configured / working / error / silent / unavailable").
 * `unavailable` gets its own tone (`info`) rather than reusing
 * `not_configured`'s (`neutral`) so the two read as different diagnoses even
 * before the label text is read -- "we haven't built this yet" is not the
 * same story as "you haven't set this up yet".
 */
const STATE_STATUS: Record<ChannelState, StatusChipStatus> = {
  working: "ok",
  error: "error",
  silent: "warn",
  not_configured: "neutral",
  unavailable: "info",
};

const RELATIVE_TIME_UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
];

/**
 * "2 ч назад" / "2 hours ago" -- picks the largest whole unit (day > hour >
 * minute) so a channel silent for days doesn't read as "4320 minutes ago".
 * `Intl.RelativeTimeFormat` supplies the per-locale grammar (units, word
 * order, singular/plural forms) directly, so no separate duration-unit i18n
 * keys are needed -- same reasoning as `EmployeeForm.tsx`'s
 * `Intl.DateTimeFormat` use for badge issue dates.
 */
function formatRelativeTime(iso: string, locale: string, now: number): string {
  const diffMs = now - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const bucket =
    RELATIVE_TIME_UNITS.find(({ ms }) => diffMs >= ms) ??
    RELATIVE_TIME_UNITS[RELATIVE_TIME_UNITS.length - 1]!;
  return rtf.format(-Math.round(diffMs / bucket.ms), bucket.unit);
}

/**
 * One channel, drawn identically regardless of kind -- brief 08's "cards
 * are drawn identically regardless of kind; that uniformity is what lets
 * the section grow". An unavailable channel renders through this same
 * component, just with no `lastEventAt` to show.
 */
function ChannelCard({ channel }: { channel: ChannelSummaryDto }) {
  const { t, i18n } = useTranslation();

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ font: "600 15px/20px var(--font-ui)", color: "var(--fg-1)" }}>
            {t(channel.labelKey)}
          </span>
          <StatusChip
            status={STATE_STATUS[channel.state]}
            label={t(`integrations.state.${channel.state}`)}
          />
        </div>
        {channel.lastEventAt && (
          <span style={{ font: "400 13px/18px var(--font-ui)", color: "var(--fg-3)" }}>
            {t("integrations.lastEvent", {
              time: formatRelativeTime(channel.lastEventAt, i18n.language, Date.now()),
            })}
          </span>
        )}
      </div>
    </Card>
  );
}

/**
 * Admin Integrations section -- Plan I-1 Task 12. Renders `GET /integrations`
 * (Task 4) as a card grid, one card per channel including `unavailable`
 * ones (a channel with no adapter yet is a full entry, not a stub -- see
 * `ChannelCard`'s doc comment and docs/design-briefs/08-integrations.md).
 * The channel page, candidates queue and keys panel that this section links
 * out to are later tasks; this screen only lists.
 */
export function IntegrationsPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useChannels();
  const channels = data ?? [];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.integrations.title")} />

      {isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : channels.length === 0 ? (
        <EmptyState
          title={t("pages.integrations.emptyTitle")}
          hint={t("pages.integrations.emptyHint")}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 16,
          }}
        >
          {channels.map((channel) => (
            <ChannelCard key={channel.type} channel={channel} />
          ))}
        </div>
      )}
    </div>
  );
}
