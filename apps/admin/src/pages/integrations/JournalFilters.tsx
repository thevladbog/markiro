import { useTranslation } from "react-i18next";

import { Alert, Button, DataTabs, Select } from "@markiro/ui";

import type {
  ChannelState,
  JournalDirectionFilter,
  JournalOutcomeFilter,
  JournalPeriod,
  JournalQuery,
} from "./api.js";

interface JournalFiltersProps {
  channelState: ChannelState;
  value: Pick<JournalQuery, "outcome" | "direction" | "period">;
  totalItems: number;
  disabled: boolean;
  onChange: (patch: Partial<JournalQuery>) => void;
  onReset: () => void;
}

const OUTCOMES: JournalOutcomeFilter[] = ["all", "error", "warn", "ok", "running"];
const PERIODS: JournalPeriod[] = ["24h", "7d", "30d", "90d"];
const DIRECTIONS: JournalDirectionFilter[] = ["all", "in", "out", "local"];

export function JournalFilters({
  channelState,
  value,
  totalItems,
  disabled,
  onChange,
  onReset,
}: JournalFiltersProps) {
  const { t } = useTranslation();
  const notice =
    channelState === "error"
      ? {
          tone: "error" as const,
          title: t("pages.integrations.channel.journal.notice.errorTitle"),
          body: t("pages.integrations.channel.journal.notice.errorBody"),
          action: t("pages.integrations.channel.journal.notice.showErrors"),
          run: () => onChange({ outcome: "error" }),
        }
      : channelState === "silent" || channelState === "unavailable"
        ? {
            tone: "warn" as const,
            title: t(`pages.integrations.channel.journal.notice.${channelState}Title`),
            body: t(`pages.integrations.channel.journal.notice.${channelState}Body`),
            action: t("pages.integrations.channel.journal.notice.showLatest"),
            run: onReset,
          }
        : null;

  return (
    <div className="mk-journal-filters">
      {notice ? (
        <Alert
          tone={notice.tone}
          title={notice.title}
          action={
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={disabled}
              onClick={notice.run}
            >
              {notice.action}
            </Button>
          }
        >
          {notice.body}
        </Alert>
      ) : null}

      <DataTabs
        label={t("pages.integrations.channel.journal.filters.outcomeLabel")}
        activeId={value.outcome}
        items={OUTCOMES.map((outcome) => ({
          id: outcome,
          label: t(`pages.integrations.channel.journal.filters.outcome.${outcome}`),
          disabled,
        }))}
        onChange={(outcome) => onChange({ outcome })}
      />

      <div className="mk-journal-filters__secondary">
        <Select
          native
          label={t("pages.integrations.channel.journal.filters.periodLabel")}
          value={value.period}
          disabled={disabled}
          options={PERIODS.map((period) => ({
            value: period,
            label: t(`pages.integrations.channel.journal.filters.period.${period}`),
          }))}
          onValueChange={(period) => onChange({ period })}
        />
        <Select
          native
          label={t("pages.integrations.channel.journal.filters.directionLabel")}
          value={value.direction}
          disabled={disabled}
          options={DIRECTIONS.map((direction) => ({
            value: direction,
            label: t(`pages.integrations.channel.journal.filters.direction.${direction}`),
          }))}
          onValueChange={(direction) => onChange({ direction })}
        />
        <p className="mk-journal-filters__count" aria-live="polite">
          {t("pages.integrations.channel.journal.resultCount", { count: totalItems })}
        </p>
      </div>
    </div>
  );
}
