import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, DatePicker, Input, Pager } from "@markiro/ui";
import { classifyScan, DomainError, normalizeToGtin14 } from "@markiro/domain";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { paginate } from "../lib/pagination.js";
import type { ScanSource } from "../lib/scan-source.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { StationScreen } from "../ui/StationScreen.js";

interface ResolvedProduct {
  id: string;
  gtin14: string;
  name: string;
  boxCapacity: number | null;
}

/** Spec-free summary from GET /shifts/box-label-templates. */
interface BoxLabelTemplateOption {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: number;
  language: string;
}

const TEMPLATE_PAGE_SIZE = 4;

export interface NewShiftProps {
  client: StationClient;
  source: ScanSource;
  onStarted: (shift: { id: string; status: string; mode: string }) => void;
  onBack: () => void;
}

export type NewShiftView = "input" | "found" | "notFound" | "template";
export type NewShiftMode = "validation" | "aggregation";

function currentLocalDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function NewShift({ client, source, onStarted, onBack }: NewShiftProps) {
  const { i18n, t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [view, setView] = useState<NewShiftView>("input");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<ResolvedProduct | null>(null);
  const [mode, setMode] = useState<NewShiftMode>("validation");
  const [productionDate, setProductionDate] = useState("");
  const [unknownGtin, setUnknownGtin] = useState<string>("");
  const [templates, setTemplates] = useState<BoxLabelTemplateOption[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatePage, setTemplatePage] = useState(1);
  const resolving = useRef(false);

  const resolveRaw = useCallback(
    async (nextRaw: string) => {
      if (resolving.current) return;
      setError(null);
      let gtin14: string;
      try {
        gtin14 = normalizeToGtin14(nextRaw);
      } catch (err) {
        setError(err instanceof DomainError ? t("shifts.gtinInvalid") : String(err));
        return;
      }

      resolving.current = true;
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
        resolving.current = false;
        setBusy(false);
      }
    },
    [client, t],
  );

  useEffect(() => {
    if (view !== "input") return;
    return source.start((scannedRaw) => {
      const scan = classifyScan(scannedRaw);
      const nextRaw =
        scan.kind === "gtin" ? scan.gtin14 : scan.kind === "km" ? scan.km.gtin14 : scannedRaw;
      setRaw(nextRaw);
      void resolveRaw(nextRaw);
    });
  }, [resolveRaw, source, view]);

  function resolve(e: FormEvent) {
    e.preventDefault();
    void resolveRaw(raw);
  }

  /**
   * Aggregation-only: refetched on every found → template transition so a
   * template created or set as default in the cabinet is visible on the next
   * attempt without restarting the flow.
   */
  async function openTemplateStep() {
    if (!product || busy) return;
    setError(null);
    setBusy(true);
    try {
      const config = await client.get<{
        items: BoxLabelTemplateOption[];
        defaultBoxLabelTemplateId: string | null;
      }>("/shifts/box-label-templates");
      const preselected =
        config.defaultBoxLabelTemplateId !== null &&
        config.items.some((item) => item.id === config.defaultBoxLabelTemplateId)
          ? config.defaultBoxLabelTemplateId
          : null;
      setTemplates(config.items);
      setDefaultTemplateId(config.defaultBoxLabelTemplateId);
      setSelectedTemplateId(preselected);
      setTemplatePage(1);
      setView("template");
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.templatesLoadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!product || busy) return;
    if (mode === "aggregation" && view === "found") {
      await openTemplateStep();
      return;
    }
    if (mode === "aggregation" && !selectedTemplateId) return;
    setError(null);
    setBusy(true);
    try {
      const requestedProductionDate = productionDate || null;
      const created = await client.post<{
        id: string;
        productionDate?: string | null;
      }>("/shifts", {
        productId: product.id,
        mode,
        plannedDate: currentLocalDate(),
        productionDate: requestedProductionDate,
        // Validation shifts print nothing; an aggregation shift snapshots
        // exactly the template the operator saw.
        ...(mode === "aggregation" ? { boxLabelTemplateId: selectedTemplateId } : {}),
      });
      if (requestedProductionDate !== null && created.productionDate !== requestedProductionDate) {
        setError(t("shifts.productionDateNotConfirmed"));
        return;
      }
      const opened = await client.post<{ id: string; status: string; mode: string }>(
        `/shifts/${created.id}/open`,
      );
      onStarted(opened);
    } catch (err) {
      setError(
        err instanceof StationApiError && err.code === "BOX_LABEL_TEMPLATE_REQUIRED"
          ? t("shifts.boxLabelTemplateRequired")
          : t("shifts.actionFailed"),
      );
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

  if (view === "template" && product) {
    const currentPage = paginate(templates, templatePage, TEMPLATE_PAGE_SIZE);
    return (
      <StationScreen
        title={t("shifts.new")}
        actions={
          <FloorFooter ariaLabel={t("shifts.newActions")}>
            <Button
              size="floor"
              fullWidth
              loading={busy}
              disabled={!selectedTemplateId}
              onClick={() => void start()}
            >
              {t("shifts.start")}
            </Button>
            <Button
              size="floor"
              fullWidth
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setError(null);
                setView("found");
              }}
            >
              {t("shifts.back")}
            </Button>
          </FloorFooter>
        }
      >
        <section
          className="new-shift__panel new-shift__panel--template"
          data-testid="new-shift-template"
        >
          <h2 className="new-shift__template-title">{t("shifts.templateLabel")}</h2>
          {templates.length === 0 ? (
            <div className="new-shift__center">
              <p>{t("shifts.templatesEmpty")}</p>
            </div>
          ) : (
            <>
              <div
                className="new-shift__templates"
                role="group"
                aria-label={t("shifts.templateLabel")}
              >
                {currentPage.items.map((option) => {
                  const selected = option.id === selectedTemplateId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={
                        selected
                          ? "new-shift__template new-shift__template--selected"
                          : "new-shift__template"
                      }
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => setSelectedTemplateId(option.id)}
                    >
                      <span className="new-shift__template-name">{option.name}</span>
                      <span className="new-shift__template-meta">
                        {t("shifts.templateMeta", {
                          width: option.widthMm,
                          height: option.heightMm,
                          dpi: option.dpi,
                        })}
                      </span>
                      {option.id === defaultTemplateId ? (
                        <span className="new-shift__template-badge">
                          {t("shifts.templateDefault")}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {currentPage.pageCount > 1 ? (
                <Pager
                  page={currentPage.page}
                  pageCount={currentPage.pageCount}
                  onPageChange={setTemplatePage}
                  ariaLabel={t("shifts.templatePagination")}
                  previousLabel={t("shifts.previousPage")}
                  nextLabel={t("shifts.nextPage")}
                  pageLabel={(page, pageCount) => t("shifts.page", { page, pageCount })}
                  className="new-shift__template-pager"
                />
              ) : null}
            </>
          )}
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
            <Button size="floor" fullWidth variant="secondary" disabled={busy} onClick={onBack}>
              {t("shifts.back")}
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
          <DatePicker
            label={t("shifts.productionDate")}
            hint={t("shifts.productionDateHint")}
            placeholder={t("shifts.productionDatePlaceholder")}
            clearLabel={t("shifts.productionDateClear")}
            calendarLabel={t("shifts.productionDateCalendar")}
            previousMonthLabel={t("shifts.productionDatePreviousMonth")}
            nextMonthLabel={t("shifts.productionDateNextMonth")}
            locale={i18n.resolvedLanguage ?? i18n.language}
            {...(productionDate ? { value: productionDate } : {})}
            disabled={busy}
            onValueChange={(value) => setProductionDate(value ?? "")}
          />
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
          <Button size="floor" fullWidth variant="secondary" disabled={busy} onClick={onBack}>
            {t("shifts.back")}
          </Button>
        </FloorFooter>
      }
    >
      <section className="new-shift__panel new-shift__panel--input" data-testid="new-shift-input">
        <form id="new-shift-resolve" onSubmit={resolve}>
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
