import type { ChzSummary, ChzStatusKey } from "@markiro/platform-contracts";
import { StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";
import { useTranslation } from "react-i18next";

/**
 * Фактический union — семь значений (`packages/platform-contracts/src/
 * tenant-national-catalog.ts`): `draft`, `moderation`, `errors`, `unsigned`,
 * `published`, `archived`, `unknown`. `published`/`errors` — прямые
 * терминальные фазы. Остальные пять разобраны по смыслу подписи
 * (`ru.json`, `pages.catalog.import.statuses`):
 * - `draft` («Черновик») — есть выделенная фаза `draft`.
 * - `moderation` («На модерации») — идущий процесс с неизвестным исходом,
 *   `running`.
 * - `unsigned` («Не подписано») — требуется действие, `attention`.
 * - `archived` («Архив») — выведено из оборота, `retired`; то же понятие в
 *   `pages/catalog/index.tsx` (`row.archived` → `retired`).
 * - `unknown` («Неизвестно») — единственный законный `none` здесь.
 */
export function chzStatusPhase(key: ChzStatusKey): TagPhase {
  switch (key) {
    case "draft":
      return "draft";
    case "moderation":
      return "running";
    case "unsigned":
      return "attention";
    case "published":
      return "done";
    case "archived":
      return "retired";
    case "unknown":
      return "none";
    case "errors":
      return "failed";
  }
}

export function ChzStatus({ summary }: { summary: ChzSummary | undefined }) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.chz.${key}`);
  if (summary === undefined) return <span>{tr("unavailable")}</span>;
  if (summary.linkId === null) return <span>{tr("unlinked")}</span>;
  const statuses = summary.statusKeys;
  const chip = (key: ChzStatusKey, index: number) => (
    <StatusChip
      key={`${key}-${index}`}
      // `summary` rides on `ProductDto.chz` (`../api.ts`), which is not
      // runtime-validated -- same gap as `invitationAccessPhase` in
      // `pages/team/TeamPage.tsx`. Guard here rather than widen
      // `chzStatusPhase`'s own return type.
      phase={chzStatusPhase(key) ?? "none"}
      label={t(`pages.catalog.import.statuses.${key}`)}
    />
  );
  const timestamp = (value: string) => (
    <time dateTime={value}>{new Date(value).toLocaleString(i18n.language)}</time>
  );
  return (
    <div className="mk-chz-status">
      {summary.lastSuccessAt === null ? (
        <span>{tr("unverified")}</span>
      ) : statuses[0] ? (
        chip(statuses[0], 0)
      ) : (
        <span>{t("pages.catalog.import.statuses.unknown")}</span>
      )}
      {summary.hasChanges && <StatusChip phase="attention" label={tr("changes")} />}
      {summary.refreshing && <span role="status">{tr("refreshing")}</span>}
      {summary.lastErrorCode && (
        <span className="mk-chz-status__error">
          {tr(summary.lastErrorCode === "photo_unavailable" ? "photoError" : "checkError")}
        </span>
      )}
      <details>
        <summary>
          {statuses.length > 1
            ? t("pages.catalog.chz.more", { count: statuses.length - 1 })
            : tr("details")}
        </summary>
        <div className="mk-chz-status__details">
          {summary.lastErrorCode && (
            <p className="mk-chz-status__error">{tr(`errors.${summary.lastErrorCode}`)}</p>
          )}
          {statuses.length > 0 && <div className="mk-chz-status__chips">{statuses.map(chip)}</div>}
          {statuses.includes("unknown") && (
            <>
              {summary.rawStatus && <p>{summary.rawStatus}</p>}
              {summary.rawDetailedStatuses.map((raw, index) => (
                <p key={index}>{raw}</p>
              ))}
            </>
          )}
          {summary.lastSuccessAt && (
            <p>
              {tr("lastSuccess")}: {timestamp(summary.lastSuccessAt)}
            </p>
          )}
          {summary.lastAttemptAt && (
            <p>
              {tr("lastAttempt")}: {timestamp(summary.lastAttemptAt)}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
