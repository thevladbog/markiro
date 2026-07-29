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
  // Distinct from "conflicts is still []" -- a genuine local read failure
  // must not be told to the operator as "no conflicts", which may directly
  // contradict the nonzero count they just tapped to investigate. This
  // screen is not the verdict area (design brief 04's floor rule is about
  // scan verdicts, not this reviewable list), so a calm, honest line here
  // competes with nothing; the Back button stays live either way.
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readConflicts(exec)
      .then((rows) => {
        if (!cancelled) setConflicts(rows);
      })
      .catch((err: unknown) => {
        console.error("station: readConflicts failed", err);
        if (!cancelled) setReadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [exec]);

  const timeFormat = new Intl.DateTimeFormat(i18n.language.startsWith("ru") ? "ru-RU" : "en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  });

  // `isBatchConflict` (lib/sync.ts) rejects a non-parsing `winningScannedAt`
  // before it ever reaches `conflicts_mirror`, but this guard stays anyway:
  // rows already stored before that check shipped, or written by any other
  // path, must not be able to take the whole list down. `new Date("x")` is
  // an Invalid Date, and `Intl.DateTimeFormat.format()` on one throws a
  // `RangeError` -- one bad row must cost one row, never the screen.
  //
  // The fallback is the raw stored string, not a generic placeholder: this
  // screen exists so the operator can find a physical item, and the exact
  // win time is secondary to that -- but the raw value still tells rows
  // apart from one another and may itself carry a clue (e.g. a
  // differently-shaped but still-readable timestamp), which a blanket
  // "unknown" would throw away.
  function formatWinTime(raw: string): string {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return timeFormat.format(date);
  }

  return (
    <main style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 style={{ fontSize: "2rem" }}>{t("conflicts.title")}</h1>
      {readFailed ? (
        <p>{t("conflicts.readFailed")}</p>
      ) : conflicts.length === 0 ? (
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
                  time: formatWinTime(c.winningScannedAt),
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Button variant="secondary" style={{ minHeight: 64 }} onClick={onBack}>
        {t("conflicts.back")}
      </Button>
    </main>
  );
}
