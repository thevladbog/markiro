import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@markiro/ui";

export function JournalList({
  entries,
}: {
  entries: { message: string; detail: string | null }[];
}): ReactElement {
  const { t } = useTranslation();
  if (entries.length === 0) return <EmptyState title={t("journal.empty")} />;
  return (
    <ul>
      {entries
        .slice()
        .reverse()
        .map((entry, index) => (
          <li key={`${entry.message}-${index}`}>
            {entry.message}
            {entry.detail ? ` — ${entry.detail}` : ""}
          </li>
        ))}
    </ul>
  );
}
