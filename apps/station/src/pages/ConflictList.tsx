import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@markiro/ui";
import { readConflicts, type DeviceConflict } from "../lib/conflicts.js";
import type { SqlExecutor } from "../lib/mirror.js";

export interface ConflictListProps {
  exec: SqlExecutor;
  onBack: () => void;
}

/**
 * Reviewable, not thrown at the operator: opened deliberately from shift
 * selection (see App.tsx), never surfaced automatically. Each row shows the
 * item's GTIN and serial — what's printed under the DataMatrix, and
 * therefore what lets a person physically find it on the line — plus which
 * terminal kept the code and when.
 */
export function ConflictList({ exec, onBack }: ConflictListProps) {
  const { t, i18n } = useTranslation();
  const [conflicts, setConflicts] = useState<DeviceConflict[]>([]);

  useEffect(() => {
    let cancelled = false;
    void readConflicts(exec)
      .then((rows) => {
        if (!cancelled) setConflicts(rows);
      })
      .catch((err: unknown) => {
        // A read failure must not strand the operator on a blank screen with
        // no way back -- it just shows as "no conflicts" (the safe, quiet
        // default) with the Back button still live.
        console.error("station: readConflicts failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec]);

  const timeFormat = new Intl.DateTimeFormat(i18n.language.startsWith("ru") ? "ru-RU" : "en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  });

  return (
    <main style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 style={{ fontSize: "2rem" }}>{t("conflicts.title")}</h1>
      {conflicts.length === 0 ? (
        <p>{t("conflicts.empty")}</p>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {conflicts.map((c) => (
            <Card key={c.codeHash} style={{ padding: 24 }}>
              <div style={{ fontSize: "1.5rem" }}>
                {/* codes_mirror rows are inserted with gtin14 and serial
                    together (see mirror.ts), so a left join miss (retention
                    already purged the code row) leaves both null at once --
                    checking either is enough, but both are checked so a
                    future partial-write bug can't silently show one field
                    blank instead of the intended fallback copy. */}
                {c.gtin14 !== null && c.serial !== null
                  ? `${c.gtin14} ${c.serial}`
                  : t("conflicts.unknownItem")}
              </div>
              <div>
                {t("conflicts.wonBy", {
                  terminal: c.winningTerminalId ?? "—",
                  time: timeFormat.format(new Date(c.winningScannedAt)),
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Button style={{ minHeight: 64 }} onClick={onBack}>
        {t("conflicts.back")}
      </Button>
    </main>
  );
}
