import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { StatusChip } from "@markiro/ui";

/** Names in Russian order, with numbers by value: «Линия 2» before «Линия 10». */
const NAMES = new Intl.Collator("ru", { numeric: true });

/** A record that is archived instead of deleted. */
export interface ArchivableRecord {
  id: string;
  name: string;
  archived: boolean;
}

/**
 * Active records before archived ones, each group by name (`NAMES`), then by
 * id so equal names keep one order. The host sorts bytewise («Линия 10»
 * before «Линия 2»), so a page sorts what it shows itself.
 */
export function activeFirstByName<T extends ArchivableRecord>(records: readonly T[]): T[] {
  return [...records].sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      NAMES.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * `records` with `record` in place of the one with its id, which keeps its
 * position, or added at the end when none has that id. A new array; neither
 * argument is changed.
 */
export function withRecord<T extends { id: string }>(records: readonly T[], record: T): T[] {
  return records.some((each) => each.id === record.id)
    ? records.map((each) => (each.id === record.id ? record : each))
    : [...records, record];
}

/**
 * Keeps a record a write returned in the cached list of `key`, in place of
 * the one with its id (`withRecord`: same position) or added; with no list
 * loaded, the whole list is read again rather than shown as one row.
 */
export function useStoreRecord<T extends { id: string }>(key: QueryKey): (record: T) => void {
  const queryClient = useQueryClient();
  return (record) => {
    const list = queryClient.getQueryData<T[]>(key);
    if (list) {
      queryClient.setQueryData(key, withRecord(list, record));
    } else {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/** Whether a record is in use or archived, in words and not by colour alone. */
export function ArchiveStatus({ archived }: { archived: boolean }) {
  const { t } = useTranslation();
  return (
    <StatusChip
      phase={archived ? "retired" : "active"}
      label={t(archived ? "office.common.archived" : "office.common.active")}
    />
  );
}
