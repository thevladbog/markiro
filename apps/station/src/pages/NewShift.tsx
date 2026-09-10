import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, DatePicker, Input, Pager } from "@markiro/ui";
import {
  classifyScan,
  DomainError,
  normalizeToGtin14,
  PRODUCT_LABEL_PROTOCOL,
  productLabelTemplateListSchema,
  productLabelValueDigest,
  validationPrintInputSchema,
  validationPrintPolicySchema,
  type ProductLabelTemplateList,
  type ValidationPrintInput,
} from "@markiro/domain";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG, type HardwareConfig } from "../lib/hardware-config.js";
import { paginate } from "../lib/pagination.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { AcquireShiftEntry, ShiftEntryLease } from "../lib/shift-entry-lease.js";
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
  /** Authoring resolution; informational only (spec 2026-09-10). */
  dpi: number;
  language: string;
}

const TEMPLATE_PAGE_SIZE = 4;

export interface NewShiftProps {
  client: StationClient;
  source: ScanSource;
  acquireShiftEntry?: AcquireShiftEntry;
  onStarted: (
    shift: { id: string; status: string; mode: string },
    lease?: ShiftEntryLease,
  ) => void | Promise<void>;
  onBack: () => void;
  hardwareConfig?: HardwareConfig;
  onSetup?: (draft: NewShiftDraft) => void;
  initialDraft?: NewShiftDraft;
  isCurrent?: () => boolean;
}

export type NewShiftView =
  "input" | "found" | "notFound" | "template" | "validationPrint" | "productTemplate";
export type NewShiftMode = "validation" | "aggregation";

interface CreatedPrintShift {
  created: { id: string; productionDate?: string | null };
  requestDigest: string;
}

/** In-memory handoff to printer settings; revalidated against the server before start. */
export interface NewShiftDraft {
  product: ResolvedProduct;
  productionDate: string;
  printEnabled: boolean;
  verificationRequired: boolean;
  productTemplateId: string | null;
  productTemplates: ProductLabelTemplateList["items"];
  createdPrintShift: CreatedPrintShift | null;
}

function currentLocalDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function NewShift({
  client,
  source,
  acquireShiftEntry,
  onStarted,
  onBack,
  hardwareConfig = DEFAULT_HARDWARE_CONFIG,
  onSetup,
  isCurrent,
  initialDraft,
}: NewShiftProps) {
  const { i18n, t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [view, setView] = useState<NewShiftView>(initialDraft ? "found" : "input");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<ResolvedProduct | null>(initialDraft?.product ?? null);
  const [printEnabled, setPrintEnabled] = useState(initialDraft?.printEnabled ?? false);
  const [verificationRequired, setVerificationRequired] = useState(
    initialDraft?.verificationRequired ?? true,
  );
  const [printProtocol, setPrintProtocol] = useState<string | null>(null);
  const [printSettingsLoaded, setPrintSettingsLoaded] = useState(false);
  const [printSettingsConfigured, setPrintSettingsConfigured] = useState(Boolean(initialDraft));
  const [productTemplates, setProductTemplates] = useState<ProductLabelTemplateList["items"]>(
    initialDraft?.productTemplates ?? [],
  );
  const [productTemplateId, setProductTemplateId] = useState<string | null>(
    initialDraft?.productTemplateId ?? null,
  );
  const [printerError, setPrinterError] = useState(false);
  const operationBusy = useRef(false);
  const createdPrintShift = useRef<CreatedPrintShift | null>(
    initialDraft?.createdPrintShift ?? null,
  );
  const [mode, setMode] = useState<NewShiftMode>("validation");
  const [productionDate, setProductionDate] = useState(initialDraft?.productionDate ?? "");
  const [unknownGtin, setUnknownGtin] = useState<string>("");
  const [templates, setTemplates] = useState<BoxLabelTemplateOption[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateSearch, setTemplateSearch] = useState("");
  const resolving = useRef(false);
  const mounted = useRef(true);
  const shiftEntryOperation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      shiftEntryOperation.current += 1;
    };
  }, []);

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
        if (!mounted.current || (isCurrent && !isCurrent())) return;
        setProduct(match);
        setPrintEnabled(false);
        setVerificationRequired(true);
        setProductTemplateId(null);
        setPrintProtocol(null);
        setPrintSettingsConfigured(false);
        setView("found");
      } catch (err) {
        setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
      } finally {
        resolving.current = false;
        setBusy(false);
      }
    },
    [client, t, isCurrent],
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
      // The server filters by the product's ЧЗ category and resolves the
      // category/organisation default; the station never sees scope metadata.
      const config = await client.get<{
        items: BoxLabelTemplateOption[];
        defaultBoxLabelTemplateId: string | null;
      }>(`/shifts/box-label-templates?productId=${encodeURIComponent(product.id)}`);
      const preselected =
        config.defaultBoxLabelTemplateId !== null &&
        config.items.some((item) => item.id === config.defaultBoxLabelTemplateId)
          ? config.defaultBoxLabelTemplateId
          : null;
      setTemplates(config.items);
      setDefaultTemplateId(config.defaultBoxLabelTemplateId);
      setSelectedTemplateId(preselected);
      setTemplatePage(1);
      setTemplateSearch("");
      setView("template");
    } catch (err) {
      setError(err instanceof StationApiError ? err.message : t("shifts.templatesLoadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function openPrintSettings() {
    if (!product || busy || operationBusy.current || (isCurrent && !isCurrent())) return;
    const operation = ++shiftEntryOperation.current;
    const current = () =>
      mounted.current && operation === shiftEntryOperation.current && (isCurrent?.() ?? true);
    setView("validationPrint");
    setError(null);
    setPrinterError(false);
    setPrintProtocol(null);
    setPrintSettingsLoaded(false);
    setBusy(true);
    operationBusy.current = true;
    try {
      const config = await client.get<{ validationPrintProtocol?: string | null }>(
        `/shifts/planning-config?productId=${encodeURIComponent(product.id)}`,
      );
      if (!current()) return;
      setPrintProtocol(config.validationPrintProtocol ?? null);
      setPrintSettingsLoaded(true);
      if (config.validationPrintProtocol !== PRODUCT_LABEL_PROTOCOL) setPrintEnabled(false);
    } catch {
      if (current()) setError(t("shifts.printSettingsLoadFailed"));
    } finally {
      operationBusy.current = false;
      if (current()) setBusy(false);
    }
  }

  async function openProductTemplateStep() {
    if (!product || busy || operationBusy.current || (isCurrent && !isCurrent())) return;
    const operation = ++shiftEntryOperation.current;
    const current = () =>
      mounted.current && operation === shiftEntryOperation.current && (isCurrent?.() ?? true);
    setError(null);
    setPrinterError(false);
    setBusy(true);
    operationBusy.current = true;
    try {
      const result = productLabelTemplateListSchema.parse(
        await client.get<unknown>(
          `/shifts/product-label-templates?productId=${encodeURIComponent(product.id)}`,
        ),
      );
      if (!current()) return;
      setProductTemplates(result.items);
      setProductTemplateId((previous) =>
        result.items.some((item) => item.id === previous) ? previous : null,
      );
      setTemplatePage(1);
      setTemplateSearch("");
      setView("productTemplate");
    } catch {
      if (current()) setError(t("shifts.templatesLoadFailed"));
    } finally {
      operationBusy.current = false;
      if (current()) setBusy(false);
    }
  }

  async function applyPrintSettings() {
    if (!product || busy || operationBusy.current || (isCurrent && !isCurrent())) return;
    if (printEnabled && view === "validationPrint") {
      await openProductTemplateStep();
      return;
    }
    if (printEnabled && !productTemplateId) return;
    setPrintSettingsConfigured(true);
    setError(null);
    setPrinterError(false);
    setView("found");
  }

  async function start() {
    if (!product || busy || operationBusy.current || (isCurrent && !isCurrent())) return;
    if (mode === "validation" && printEnabled && !productTemplateId) {
      await openProductTemplateStep();
      return;
    }
    if (mode === "aggregation" && view === "found") {
      await openTemplateStep();
      return;
    }
    if (mode === "aggregation" && !selectedTemplateId) return;
    const operation = ++shiftEntryOperation.current;
    let lease: ShiftEntryLease | null = null;
    const current = (): boolean =>
      mounted.current &&
      shiftEntryOperation.current === operation &&
      (lease?.isCurrent() ?? true) &&
      (isCurrent?.() ?? true);
    setError(null);
    setPrinterError(false);
    setBusy(true);
    operationBusy.current = true;
    try {
      if (acquireShiftEntry) {
        lease = await acquireShiftEntry();
        if (!current()) return;
      }
      let validationPrint: ValidationPrintInput = { mode: "none" };
      if (mode === "validation" && printEnabled) {
        const config = await client.get<{ validationPrintProtocol?: string | null }>(
          `/shifts/planning-config?productId=${encodeURIComponent(product.id)}`,
        );
        if (!current()) return;
        if (config.validationPrintProtocol !== PRODUCT_LABEL_PROTOCOL) {
          setError(t("shifts.printUnavailable"));
          return;
        }
        const latest = productLabelTemplateListSchema.parse(
          await client.get<unknown>(
            `/shifts/product-label-templates?productId=${encodeURIComponent(product.id)}`,
          ),
        );
        if (!current()) return;
        const selected = latest.items.find((template) => template.id === productTemplateId);
        if (!selected) {
          setProductTemplates(latest.items);
          setProductTemplateId(null);
          setError(t("shifts.productTemplateUnavailable"));
          return;
        }
        if (
          !hardwareConfig.printer ||
          !hardwareConfig.printerDpi ||
          !["zpl", "tspl"].includes(hardwareConfig.printerLanguage)
        ) {
          setPrinterError(true);
          setError(t("shifts.printHardwareRequired"));
          return;
        }
        validationPrint = validationPrintInputSchema.parse({
          mode: "duplicate_dm",
          templateId: selected.id,
          verification: verificationRequired ? "required" : "none",
        });
      }
      const requestedProductionDate = productionDate || null;
      const createInput = {
        productId: product.id,
        mode,
        plannedDate: currentLocalDate(),
        productionDate: requestedProductionDate,
        // Unchanged validation keeps the legacy no-print payload. Explicit
        // settings use the shared policy input, including an explicit opt-out.
        ...(mode === "validation" && (printEnabled || printSettingsConfigured)
          ? { validationPrint }
          : {}),
        ...(mode === "aggregation" ? { boxLabelTemplateId: selectedTemplateId } : {}),
      };
      const requestDigest = productLabelValueDigest(createInput);
      if (createdPrintShift.current && createdPrintShift.current.requestDigest !== requestDigest) {
        setError(t("shifts.printPolicyNotConfirmed"));
        return;
      }
      const created =
        createdPrintShift.current?.created ??
        (await client.post<{ id: string; productionDate?: string | null }>("/shifts", createInput));
      if (!current()) return;
      if (validationPrint.mode === "duplicate_dm")
        createdPrintShift.current = { created, requestDigest };
      if (requestedProductionDate !== null && created.productionDate !== requestedProductionDate) {
        setError(t("shifts.productionDateNotConfirmed"));
        return;
      }
      const opened = await client.post<{
        id: string;
        status: string;
        mode: string;
        validationPrint?: unknown;
      }>(`/shifts/${created.id}/open`);
      if (!current()) return;
      if (validationPrint.mode === "none" && opened.validationPrint !== undefined) {
        const authoritative = validationPrintPolicySchema.safeParse(opened.validationPrint);
        if (!authoritative.success || authoritative.data.mode !== "none") {
          setError(t("shifts.printPolicyNotConfirmed"));
          return;
        }
      }
      if (validationPrint.mode === "duplicate_dm") {
        const authoritative = validationPrintPolicySchema.safeParse(opened.validationPrint);
        if (
          !authoritative.success ||
          authoritative.data.mode !== "duplicate_dm" ||
          authoritative.data.templateId !== validationPrint.templateId ||
          authoritative.data.verification !== validationPrint.verification ||
          opened.mode !== "validation" ||
          opened.status !== "active"
        ) {
          setError(t("shifts.printPolicyNotConfirmed"));
          return;
        }
      }
      if (lease) await onStarted(opened, lease);
      else await onStarted(opened);
      if (!current()) return;
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof StationApiError && err.code === "BOX_LABEL_TEMPLATE_REQUIRED"
          ? t("shifts.boxLabelTemplateRequired")
          : t("shifts.actionFailed"),
      );
    } finally {
      lease?.release();
      operationBusy.current = false;
      if (mounted.current && shiftEntryOperation.current === operation) setBusy(false);
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

  if (view === "validationPrint" && product) {
    return (
      <StationScreen
        title={t("shifts.printSettingsTitle")}
        actions={
          <FloorFooter ariaLabel={t("shifts.newActions")}>
            <Button
              data-testid="new-shift-print-continue"
              size="floor"
              fullWidth
              loading={busy}
              onClick={() => void applyPrintSettings()}
            >
              {t(printEnabled ? "shifts.selectProductTemplate" : "shifts.applyPrintSettings")}
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
        <section className="new-shift__panel new-shift__print-settings">
          <Card className="new-shift__product" padding="var(--sp-3)">
            <h2>{product.name}</h2>
            <div className="new-shift__code">{product.gtin14}</div>
          </Card>
          <div className="new-shift__print-choices">
            <label className="setup-touch-choice setup-touch-choice--checkbox">
              <input
                type="checkbox"
                name="duplicate-print"
                checked={printEnabled}
                disabled={busy || printProtocol !== PRODUCT_LABEL_PROTOCOL}
                onChange={(event) => {
                  setPrintEnabled(event.target.checked);
                  if (!event.target.checked) setProductTemplateId(null);
                }}
              />
              <span>{t("shifts.printDuplicate")}</span>
            </label>
            {printEnabled ? (
              <div className="new-shift__verification-choice">
                <label className="setup-touch-choice setup-touch-choice--checkbox">
                  <input
                    type="checkbox"
                    name="duplicate-verification"
                    checked={verificationRequired}
                    disabled={busy}
                    onChange={(event) => setVerificationRequired(event.target.checked)}
                  />
                  <span>{t("shifts.requireProductLabelVerification")}</span>
                </label>
                <p>
                  {t(verificationRequired ? "shifts.printRequiredHint" : "shifts.printNoneHint")}
                </p>
              </div>
            ) : (
              <p className="new-shift__print-hint">{t("shifts.printCopyHint")}</p>
            )}
          </div>
          {!busy && printSettingsLoaded && printProtocol !== PRODUCT_LABEL_PROTOCOL ? (
            <Alert tone="info">{t("shifts.printUnavailable")}</Alert>
          ) : null}
          {error ? (
            <Button size="floor" variant="secondary" onClick={() => void openPrintSettings()}>
              {t("shifts.retryPrintSettings")}
            </Button>
          ) : null}
          {messageSlot}
        </section>
      </StationScreen>
    );
  }

  if ((view === "template" || view === "productTemplate") && product) {
    const productLabels = view === "productTemplate";
    const choices = productLabels ? productTemplates : templates;
    const selectedId = productLabels ? productTemplateId : selectedTemplateId;
    const templateTitle = productLabels ? "shifts.productTemplateLabel" : "shifts.templateLabel";
    const needle = templateSearch.trim().toLocaleLowerCase();
    const visibleTemplates = needle
      ? choices.filter((option) => option.name.toLocaleLowerCase().includes(needle))
      : choices;
    const currentPage = paginate(visibleTemplates, templatePage, TEMPLATE_PAGE_SIZE);
    return (
      <StationScreen
        title={t("shifts.new")}
        actions={
          <FloorFooter ariaLabel={t("shifts.newActions")}>
            <Button
              size="floor"
              fullWidth
              loading={busy}
              disabled={!selectedId}
              onClick={() => void (productLabels ? applyPrintSettings() : start())}
            >
              {t(productLabels ? "shifts.applyPrintSettings" : "shifts.start")}
            </Button>
            <Button
              size="floor"
              fullWidth
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setError(null);
                if (productLabels) void openPrintSettings();
                else setView("found");
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
          <h2 className="new-shift__template-title">{t(templateTitle)}</h2>
          {choices.length === 0 ? (
            <div className="new-shift__center">
              <p>{t("shifts.templatesEmpty")}</p>
            </div>
          ) : (
            <>
              <Input
                id="template-search"
                size="floor"
                type="search"
                label={t("shifts.templateSearch")}
                value={templateSearch}
                disabled={busy}
                onChange={(event) => {
                  setTemplateSearch(event.target.value);
                  setTemplatePage(1);
                }}
              />
              {visibleTemplates.length === 0 ? (
                <div className="new-shift__center">
                  <p>{t("shifts.templateSearchEmpty")}</p>
                </div>
              ) : null}
              <div className="new-shift__templates" role="group" aria-label={t(templateTitle)}>
                {currentPage.items.map((option) => {
                  const selected = option.id === selectedId;
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
                      onClick={() =>
                        productLabels
                          ? setProductTemplateId(option.id)
                          : setSelectedTemplateId(option.id)
                      }
                    >
                      <span className="new-shift__template-name">{option.name}</span>
                      <span className="new-shift__template-meta">
                        {t("shifts.templateMeta", {
                          width: option.widthMm,
                          height: option.heightMm,
                        })}
                      </span>
                      {!productLabels && option.id === defaultTemplateId ? (
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
            {printerError && onSetup ? (
              <Button
                size="floor"
                fullWidth
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  onSetup({
                    product,
                    productionDate,
                    printEnabled,
                    verificationRequired,
                    productTemplateId,
                    productTemplates,
                    createdPrintShift: createdPrintShift.current,
                  })
                }
              >
                {t("shifts.printerSettings")}
              </Button>
            ) : null}
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
              onClick={() => {
                setMode("aggregation");
                setPrintEnabled(false);
                setProductTemplateId(null);
              }}
            >
              {t("shifts.modeAggregation")}
            </Button>
          </div>
          {mode === "validation" ? (
            <Button
              size="floor"
              fullWidth
              variant="secondary"
              disabled={busy}
              onClick={() => void openPrintSettings()}
              data-testid="new-shift-print-settings"
            >
              {t("shifts.printSettingsEntry", {
                mode: t(printEnabled ? "shifts.printDuplicateShort" : "shifts.printOff"),
              })}
            </Button>
          ) : null}
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
