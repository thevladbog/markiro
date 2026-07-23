import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
import { DomainError, normalizeToGtin14 } from "@markiro/domain";
import { StationApiError, type StationClient } from "../lib/api-client.js";

interface ResolvedProduct {
  id: string;
  gtin14: string;
  name: string;
  boxCapacity: number | null;
}

export interface NewShiftProps {
  client: StationClient;
  onStarted: (shift: { id: string; status: string; mode: string }) => void;
  onBack: () => void;
}

type View = "input" | "found" | "notFound";

export function NewShift({ client, onStarted, onBack }: NewShiftProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [view, setView] = useState<View>("input");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<ResolvedProduct | null>(null);
  const [mode, setMode] = useState<"validation" | "aggregation">("validation");
  const [unknownGtin, setUnknownGtin] = useState<string>("");

  async function resolve(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    let gtin14: string;
    try {
      gtin14 = normalizeToGtin14(raw);
    } catch (err) {
      setError(err instanceof DomainError ? t("shifts.gtinInvalid") : String(err));
      return;
    }
    setBusy(true);
    try {
      // Owner hint (also validates against the catalog indirectly).
      await client.post<{ gtin14: string; owner: string }>("/products/gtin-check", { gtin: gtin14 });
      const list = await client.get<{ items: ResolvedProduct[] }>(`/products?search=${gtin14}`);
      const match = list.items.find((p) => p.gtin14 === gtin14) ?? null;
      if (!match) {
        setUnknownGtin(gtin14);
        setView("notFound");
        return;
      }
      setProduct(match);
      setView("found");
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!product || busy) return;
    setError(null);
    setBusy(true);
    try {
      const created = await client.post<{ id: string }>("/shifts", { productId: product.id, mode });
      const opened = await client.post<{ id: string; status: string; mode: string }>(`/shifts/${created.id}/open`);
      onStarted(opened);
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (view === "notFound") {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}>
        <h1 style={{ fontSize: "2rem" }}>{t("shifts.notInCatalog")}</h1>
        <p style={{ fontSize: "1.25rem" }}>GTIN: {unknownGtin}</p>
        <p>{t("shifts.notInCatalogHint")}</p>
        <div style={{ display: "flex", gap: 12 }}>
          <Button style={{ minHeight: 64 }} onClick={() => { setRaw(""); setView("input"); }}>
            {t("shifts.scanAgain")}
          </Button>
          <Button variant="secondary" style={{ minHeight: 64 }} onClick={onBack}>
            {t("shifts.back")}
          </Button>
        </div>
      </main>
    );
  }

  if (view === "found" && product) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}>
        <Card style={{ padding: 24, minWidth: 480 }}>
          <div style={{ fontSize: "1.75rem" }}>{product.name}</div>
          <div>{product.gtin14}</div>
        </Card>
        <div style={{ display: "flex", gap: 12 }}>
          <Button variant={mode === "validation" ? "primary" : "secondary"} style={{ minHeight: 64 }} onClick={() => setMode("validation")}>
            {t("shifts.modeValidation")}
          </Button>
          <Button variant={mode === "aggregation" ? "primary" : "secondary"} style={{ minHeight: 64 }} onClick={() => setMode("aggregation")}>
            {t("shifts.modeAggregation")}
          </Button>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button style={{ minHeight: 64 }} disabled={busy} onClick={() => void start()}>
          {t("shifts.start")}
        </Button>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}>
      <form onSubmit={(e) => void resolve(e)} style={{ display: "grid", gap: 16, minWidth: 480 }}>
        <label htmlFor="gtin" style={{ fontSize: "1.25rem" }}>{t("shifts.gtinPrompt")}</label>
        <Input id="gtin" autoFocus value={raw} onChange={(e) => setRaw(e.target.value)} />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" style={{ minHeight: 64 }} disabled={busy}>{t("shifts.open")}</Button>
      </form>
    </main>
  );
}
