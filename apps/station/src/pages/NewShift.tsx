import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
import { DomainError, normalizeToGtin14 } from "@markiro/domain";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { StationScreen } from "../ui/StationScreen.js";

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

export type NewShiftView = "input" | "found" | "notFound";
export type NewShiftMode = "validation" | "aggregation";

export function NewShift({ client, onStarted, onBack }: NewShiftProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [view, setView] = useState<NewShiftView>("input");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<ResolvedProduct | null>(null);
  const [mode, setMode] = useState<NewShiftMode>("validation");
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
      await client.post<{ gtin14: string; owner: string }>("/products/gtin-check", {
        gtin: gtin14,
      });
      const list = await client.get<{ items: ResolvedProduct[] }>(`/products?search=${gtin14}`);
      const match = list.items.find((candidate) => candidate.gtin14 === gtin14) ?? null;
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
      const opened = await client.post<{ id: string; status: string; mode: string }>(
        `/shifts/${created.id}/open`,
      );
      onStarted(opened);
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const messageSlot = (
    <div className="new-shift__message" data-testid="new-shift-message-slot">
      {error ? <Alert tone="error">{error}</Alert> : <span aria-hidden="true" />}
    </div>
  );

  if (view === "notFound") {
    return (
      <StationScreen
        title={t("shifts.new")}
        actions={
          <FloorFooter ariaLabel={t("shifts.newActions")}>
            <Button
              size="floor"
              onClick={() => {
                setRaw("");
                setError(null);
                setView("input");
              }}
            >
              {t("shifts.scanAgain")}
            </Button>
            <Button size="floor" variant="secondary" onClick={onBack}>
              {t("shifts.back")}
            </Button>
          </FloorFooter>
        }
      >
        <section
          className="new-shift__panel new-shift__panel--missing"
          data-testid="new-shift-missing"
        >
          <div className="new-shift__center">
            <h2>{t("shifts.notInCatalog")}</h2>
            <p className="new-shift__code">GTIN: {unknownGtin}</p>
            <p>{t("shifts.notInCatalogHint")}</p>
          </div>
          {messageSlot}
        </section>
      </StationScreen>
    );
  }

  if (view === "found" && product) {
    return (
      <StationScreen
        title={t("shifts.new")}
        actions={
          <FloorFooter ariaLabel={t("shifts.newActions")}>
            <Button size="floor" fullWidth loading={busy} onClick={() => void start()}>
              {t("shifts.start")}
            </Button>
          </FloorFooter>
        }
      >
        <section className="new-shift__panel new-shift__panel--found" data-testid="new-shift-found">
          <Card className="new-shift__product" padding="var(--sp-3)">
            <h2>{product.name}</h2>
            <div className="new-shift__code">{product.gtin14}</div>
          </Card>
          <div className="new-shift__modes" role="group" aria-label={t("shifts.modeLabel")}>
            <Button
              size="floor"
              fullWidth
              variant={mode === "validation" ? "primary" : "secondary"}
              aria-pressed={mode === "validation"}
              onClick={() => setMode("validation")}
            >
              {t("shifts.modeValidation")}
            </Button>
            <Button
              size="floor"
              fullWidth
              variant={mode === "aggregation" ? "primary" : "secondary"}
              aria-pressed={mode === "aggregation"}
              onClick={() => setMode("aggregation")}
            >
              {t("shifts.modeAggregation")}
            </Button>
          </div>
          {messageSlot}
        </section>
      </StationScreen>
    );
  }

  return (
    <StationScreen
      title={t("shifts.new")}
      actions={
        <FloorFooter ariaLabel={t("shifts.newActions")}>
          <Button size="floor" type="submit" form="new-shift-resolve" fullWidth loading={busy}>
            {t("shifts.open")}
          </Button>
        </FloorFooter>
      }
    >
      <section className="new-shift__panel new-shift__panel--input" data-testid="new-shift-input">
        <form id="new-shift-resolve" onSubmit={(event) => void resolve(event)}>
          <Input
            id="gtin"
            size="floor"
            mono
            label={t("shifts.gtinPrompt")}
            autoFocus
            value={raw}
            disabled={busy}
            onChange={(event) => setRaw(event.target.value)}
          />
        </form>
        {messageSlot}
      </section>
    </StationScreen>
  );
}
