import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card } from "@markiro/ui";
import { StationApiError, type StationClient } from "../lib/api-client.js";

interface ShiftListItem {
  id: string;
  status: "planned" | "active" | "closed";
  mode: "validation" | "aggregation";
  productName: string | null;
  plannedQty: number | null;
  counterpartyName?: string | null;
}

export interface ShiftSelectionProps {
  client: StationClient;
  onSelected: (shift: { id: string; status: string; mode: string }) => void;
  onNew: () => void;
}

export function ShiftSelection({ client, onSelected, onNew }: ShiftSelectionProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ShiftListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .get<{ items: ShiftListItem[] }>("/shifts")
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  async function open(shift: ShiftListItem) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const opened = await client.post<{ id: string; status: string; mode: string }>(`/shifts/${shift.id}/open`);
      onSelected(opened);
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  function rejoin(shift: ShiftListItem) {
    if (busy) return;
    onSelected(shift);
  }

  return (
    <main style={{ minHeight: "100vh", padding: 32 }}>
      <h1 style={{ fontSize: "2.25rem", marginBottom: 24 }}>{t("shifts.title")}</h1>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div style={{ display: "grid", gap: 16 }}>
        {items
          .filter((s) => s.status !== "closed")
          .map((s) => (
            <Card key={s.id} style={{ padding: 24 }}>
              <div style={{ fontSize: "1.5rem" }}>{s.productName}</div>
              {s.counterpartyName ? <div>для: {s.counterpartyName}</div> : null}
              <Button
                style={{ minHeight: 64, marginTop: 12 }}
                disabled={busy}
                onClick={() => (s.status === "active" ? rejoin(s) : void open(s))}
              >
                {s.status === "active" ? t("shifts.rejoin") : t("shifts.open")}
              </Button>
            </Card>
          ))}
        <Button style={{ minHeight: 64 }} onClick={onNew}>
          {t("shifts.new")}
        </Button>
      </div>
    </main>
  );
}
