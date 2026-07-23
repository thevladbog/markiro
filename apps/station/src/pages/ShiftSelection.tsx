import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@markiro/ui";
import type { StationClient } from "../lib/api-client.js";

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

  useEffect(() => {
    void client.get<{ items: ShiftListItem[] }>("/shifts").then((r) => setItems(r.items));
  }, [client]);

  async function open(shift: ShiftListItem) {
    const opened = await client.post<{ id: string; status: string; mode: string }>(`/shifts/${shift.id}/open`);
    onSelected(opened);
  }

  return (
    <main style={{ minHeight: "100vh", padding: 32 }}>
      <h1 style={{ fontSize: "2.25rem", marginBottom: 24 }}>{t("shifts.title")}</h1>
      <div style={{ display: "grid", gap: 16 }}>
        {items
          .filter((s) => s.status !== "closed")
          .map((s) => (
            <Card key={s.id} style={{ padding: 24 }}>
              <div style={{ fontSize: "1.5rem" }}>{s.productName}</div>
              {s.counterpartyName ? <div>для: {s.counterpartyName}</div> : null}
              <Button
                style={{ minHeight: 64, marginTop: 12 }}
                onClick={() => (s.status === "active" ? onSelected(s) : void open(s))}
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
