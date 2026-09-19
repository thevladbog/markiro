import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Card, EmptyState, PageHeader, Spinner, StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";

import { useChannels, type ChannelState, type ChannelSummaryDto } from "./api.js";

/**
 * State -> phase, one-to-one with the five `ChannelState` values (brief 08's
 * "not configured / working / error / silent / unavailable").
 *
 * `not_configured` is the only legitimate `none` here: there genuinely is no
 * value and none is expected until an operator sets the channel up.
 * `unavailable` is a different story -- brief 08 calls it "a connection we
 * have not built yet", and `JournalFilters.tsx` already treats it exactly
 * like `silent` (same `warn`-toned notice, same "show me the latest" action):
 * both are "this channel should be doing something and isn't", which is
 * `attention`, not an absence of value.
 */
export const CHANNEL_STATE_TO_PHASE: Record<ChannelState, TagPhase> = {
  working: "active",
  error: "failed",
  silent: "attention",
  not_configured: "none",
  unavailable: "attention",
};

/**
 * `ChannelSummaryDto` carries no field for "what this channel connects to"
 * (brief 08's card anatomy: "name, what it connects to, state chip, last
 * event") -- only `labelKey`, which the registry always sets to
 * `integrations.channel.<name>` (see `apps/api/src/modules/integrations/
 * channel-registry.ts`). Deriving the description key from that same string
 * keeps it tied to channel identity without a second server field or a
 * dependency on `channel.type`'s union -- `api.ts` already explains why
 * `type` deliberately stays untyped on this side.
 */
function channelDescriptionKey(labelKey: string): string {
  return labelKey.replace(".channel.", ".channelDescription.");
}

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
 *
 * Task 13 gives every OTHER card a primary action: opening its channel page
 * (`/integrations/:type`, header/settings/journal). An `unavailable` channel
 * stays unlinked -- brief 08's "an unavailable channel is drawn like the
 * rest... with no actions" -- opening it would land on a page with nothing
 * real to configure yet.
 */
function ChannelCard({ channel }: { channel: ChannelSummaryDto }) {
  const { t, i18n } = useTranslation();

  const body = (
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
          phase={CHANNEL_STATE_TO_PHASE[channel.state]}
          label={t(`integrations.state.${channel.state}`)}
        />
      </div>
      <span style={{ font: "400 13px/18px var(--font-ui)", color: "var(--fg-3)" }}>
        {t(channelDescriptionKey(channel.labelKey))}
      </span>
      {channel.lastEventAt && (
        <span style={{ font: "400 13px/18px var(--font-ui)", color: "var(--fg-3)" }}>
          {t("integrations.lastEvent", {
            time: formatRelativeTime(channel.lastEventAt, i18n.language, Date.now()),
          })}
        </span>
      )}
    </div>
  );

  if (channel.state === "unavailable") {
    return <Card>{body}</Card>;
  }

  return (
    // `padding={0}`: `Card`'s own body padding moves onto the `Link` below
    // so the whole card -- not just its text -- is the click target.
    <Card padding={0}>
      <Link
        to={`/integrations/${channel.type}`}
        style={{ display: "block", padding: 20, textDecoration: "none", color: "inherit" }}
      >
        {body}
      </Link>
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
