import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, DatePicker, Input } from "@markiro/ui";

import type { LabelTemplateSpec } from "@markiro/domain";

import type {
  DeviceShift,
  DeviceShiftCreate,
  EnteredShift,
  ShiftEnter,
  ShiftMode,
} from "../../host/protocol.js";
import type { DeviceShiftInput } from "../../host/requests.js";
import { suggestBoxTemplate, suggestPalletTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { plannedQtyRule, shiftBoxCapacityRule, toCount } from "../../lib/rules.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";
import { readWarehouseTemplates } from "../warehouse/warehouse-templates.js";
import { FloorFooter, FloorScreen } from "./FloorScreen.js";
import {
  createdCopy,
  createStationShift,
  findScannedProduct,
  fittingDuplicateTemplates,
  fittingPalletTemplates,
  fittingTemplates,
  isShiftOfRequest,
  palletCapacityOffered,
  readNewShiftChoices,
  type CreateRefusal,
  type NewShiftChoices,
  type ShiftProduct,
} from "./new-shift.js";
import type { WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { formatCivilDate, formatQuantity } from "./shift-text.js";
import { productMonogram } from "./product-accent.js";
import { ProductPanel } from "./ProductPhoto.js";
import { TemplatePreview } from "./TemplatePreview.js";

/** At most this many products answer a search by name. */
const RESULTS = 5;
/** A search starts at two letters, as the operator search does. */
const MIN_QUERY_LETTERS = 2;

export interface NewShiftProps {
  local: LocalExecutor;
  pairing: Pairing;
  online: boolean;
  /** The scanner of the floor: a product is chosen by its barcode or code of marking. */
  source: ScanSource;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string, enter: ShiftEnter) => Promise<EnteredShift>;
  onEntered: (shift: WorkShift) => void;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  onBack: () => void;
  /** A new request id per form; tests give their own. */
  newRequestId?: () => string;
  /** This computer's clock; tests give their own. */
  now?: () => Date;
}

type Choices =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "not_ready" }
  | { kind: "ready"; choices: NewShiftChoices };

interface Form {
  product: ShiftProduct;
  requestId: string;
  templateId: string | null;
  /** The rule chose the template, or only one fits: nothing to choose. */
  templateFixed: boolean;
  productionDate: string;
  /** «Дата смены»: the working day, today in the organization's zone until the operator moves it. */
  plannedDate: string;
  plannedQty: string;
  boxCapacity: string;
  /** «С паллетами» (plan ПЛ-Ц): on by default when the product offers pallets (`palletCapacityOffered`). */
  pallets: boolean;
  palletTemplateId: string | null;
  /** The rule chose the pallet template, or only one fits. */
  palletTemplateFixed: boolean;
  /** «Режим работы» (plan РЕЖ): «Агрегация» unless the operator chose «Проверка». */
  mode: ShiftMode;
  /** «Печатать дубликат Data Matrix»: only a validation shift prints. */
  printDuplicate: boolean;
  /** The duplicate template: the only one that fits, or the operator's choice. */
  duplicateTemplateId: string | null;
  /** «Обязательная проверка этикетки». */
  verificationRequired: boolean;
  /**
   * The shift the host has answered for this form's request id. From then on
   * the form is frozen (a repeated id brings this shift back whatever the form
   * says) and the button only enters it. `matches` is whether it is the form's
   * own: if not, an earlier request made it and the operator is told so.
   */
  created: { shift: DeviceShift; matches: boolean } | null;
}

type Problem =
  | { kind: "scan"; key: string; gtin: string | null }
  | { kind: "create"; reason: CreateRefusal }
  | { kind: "existing"; shift: DeviceShift; pallets: boolean }
  | { kind: "enter"; number: string; reason: EntryRefusal };

/**
 * The form's three views, after the cloud station's `found` and template
 * steps: the shift's details, then the box template with its preview, then
 * — for a shift with pallets — the pallet template with its preview.
 */
type FormView = "details" | "box_template" | "pallet_template" | "duplicate_template";

/**
 * The form's views in order for the form's mode: an aggregation shift chooses
 * its box template and, with pallets, the pallet template; a validation shift
 * prints no box label (its box template is the rule's, never asked) and, when it
 * prints a duplicate, chooses the duplicate template.
 */
function viewsOf(form: Form, from: NewShiftChoices): FormView[] {
  if (form.mode === "validation") {
    return form.printDuplicate ? ["details", "duplicate_template"] : ["details"];
  }
  const withPallets =
    form.pallets && palletCapacityOffered(form.product, from.palletTemplates) !== null;
  return withPallets ? ["details", "box_template", "pallet_template"] : ["details", "box_template"];
}

/** The box template the request names: the form's, or for a validation shift the first that fits. */
function boxTemplateOf(form: Form, from: NewShiftChoices): string | null {
  if (form.templateId !== null) return form.templateId;
  if (form.mode !== "validation") return null;
  return fittingTemplates(form.product, from.templates)[0]?.id ?? null;
}

type Step = { kind: "product" } | { kind: "form"; form: Form; view: FormView };

/**
 * The pallets a form asks of the host (plan ПЛ-Ц): none, pallets (the product's
 * boxes per pallet and a pallet template that fits it), or pallets the shift
 * cannot have, which is no shift to ask for: a shift the work screen would
 * refuse (no capacity, no layout) is never made. One answer for the button
 * and the request.
 */
function palletsOf(
  form: Form,
  from: NewShiftChoices,
):
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "pallets"; pallets: NonNullable<DeviceShiftInput["pallets"]> } {
  if (!form.pallets || form.mode === "validation") return { kind: "none" };
  const boxCapacity = palletCapacityOffered(form.product, from.palletTemplates);
  const template = fittingPalletTemplates(form.product, from.palletTemplates).find(
    (each) => each.id === form.palletTemplateId,
  );
  if (boxCapacity === null || template === undefined) return { kind: "unavailable" };
  return { kind: "pallets", pallets: { boxCapacity, templateId: template.id } };
}

function letters(text: string): number {
  return Array.from(text).filter((character) => /\p{L}/u.test(character)).length;
}

/**
 * A shift created on the station (stage 2a spec §5.7.2, the cloud station's
 * `NewShift` without its cloud parts): the product by its barcode or code of
 * marking, or by name, among the products in use; the box template by the
 * rule of decision 7 (`suggestBoxTemplate`), chosen by the operator when the
 * rule leaves several; the production date, today in the organization's
 * zone; the plan, optional; the capacity from the product; and, for a product
 * with boxes per pallet and a pallet template that fits, «С паллетами» with
 * the pallet template by the same rule (plan ПЛ-Ц). It needs the host:
 * the host numbers the shift, then the station enters it at once. One
 * request id per form, kept through retries, so a retry after a lost answer
 * makes no second shift.
 */
export function NewShift({
  local,
  pairing,
  online,
  source,
  create,
  enter,
  onEntered,
  onHostError,
  onBack,
  newRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
}: NewShiftProps) {
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const [choices, setChoices] = useState<Choices>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<Step>({ kind: "product" });
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [errors, setErrors] = useState<{ plannedQty?: string; boxCapacity?: string }>({});
  const [busy, setBusy] = useState<"creating" | "entering" | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The latest props, for answers that land later and for the scanner's
  // listener, which is not restarted (and its keys dropped) on every render.
  const current = useRef({ online, onEntered, onHostError, newRequestId, now });
  useLayoutEffect(() => {
    current.current = { online, onEntered, onHostError, newRequestId, now };
  });

  useEffect(() => {
    let cancelled = false;
    readNewShiftChoices(local, { hostId, deviceId }).then(
      (read) => {
        if (!cancelled)
          setChoices(read === null ? { kind: "not_ready" } : { kind: "ready", choices: read });
      },
      () => {
        if (!cancelled) setChoices({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, attempt]);

  const ready = choices.kind === "ready" ? choices.choices : null;
  const choose = useCallback(
    (product: ShiftProduct) => {
      if (ready === null) return;
      const fitting = fittingTemplates(product, ready.templates);
      const suggested = suggestBoxTemplate(product, ready.templates, ready.defaults);
      const [only] = fitting;
      const fixed = suggested ?? (fitting.length === 1 && only !== undefined ? only.id : null);
      const palletFitting = fittingPalletTemplates(product, ready.palletTemplates);
      const [onlyPallet] = palletFitting;
      const palletFixed =
        suggestPalletTemplate(product, ready.palletTemplates, ready.defaults) ??
        (palletFitting.length === 1 && onlyPallet !== undefined ? onlyPallet.id : null);
      const duplicateFitting = fittingDuplicateTemplates(product, ready.duplicateTemplates);
      const [onlyDuplicate] = duplicateFitting.length === 1 ? duplicateFitting : [];
      setProblem(null);
      setErrors({});
      setStep({
        kind: "form",
        view: "details",
        form: {
          product,
          requestId: current.current.newRequestId(),
          templateId: fixed,
          templateFixed: fixed !== null,
          productionDate: civilToday(ready.timeZone, current.current.now()),
          plannedDate: civilToday(ready.timeZone, current.current.now()),
          plannedQty: "",
          boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
          pallets: palletCapacityOffered(product, ready.palletTemplates) !== null,
          palletTemplateId: palletFixed,
          palletTemplateFixed: palletFixed !== null,
          mode: "aggregation",
          printDuplicate: false,
          duplicateTemplateId: onlyDuplicate?.id ?? null,
          verificationRequired: false,
          created: null,
        },
      });
    },
    [ready],
  );

  // The scanner chooses the product on the first step.
  const onProductStep = step.kind === "product";
  useEffect(() => {
    if (!onProductStep || ready === null) return;
    return source.start((raw) => {
      const found = findScannedProduct(ready.products, raw);
      if (found.kind === "found") {
        choose(found.product);
        return;
      }
      setProblem({
        kind: "scan",
        key: found.kind,
        gtin: found.kind === "not_product" ? null : found.gtin14,
      });
    });
  }, [onProductStep, ready, source, choose]);
  // Typing a name takes no scan; the scanner is given back when the field
  // goes, whatever made it go.
  useLayoutEffect(() => {
    if (!onProductStep) return;
    return () => source.setManualTextEntryActive(false);
  }, [onProductStep, source]);

  const update = (change: Partial<Form>) =>
    setStep((previous) =>
      previous.kind === "form" ? { ...previous, form: { ...previous.form, ...change } } : previous,
    );
  const go = (view: FormView) =>
    setStep((previous) => (previous.kind === "form" ? { ...previous, view } : previous));

  // The layouts of the templates, for the preview of the one chosen; read once
  // the form opens. A read that fails leaves the preview out, not the choice.
  const formOpen = step.kind === "form";
  const [specs, setSpecs] = useState<ReadonlyMap<string, LabelTemplateSpec> | null>(null);
  useEffect(() => {
    if (!formOpen) return undefined;
    let cancelled = false;
    readWarehouseTemplates(local).then(
      (read) => {
        if (cancelled) return;
        const found = new Map<string, LabelTemplateSpec>();
        for (const template of read)
          if (template.spec !== null) found.set(template.id, template.spec);
        setSpecs(found);
      },
      () => {
        if (!cancelled) setSpecs(new Map());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [formOpen, local]);

  /** One request at a time: `work` runs alone, with the busy line and no old problem on the screen. */
  const run = async (kind: "creating" | "entering", work: () => Promise<void>) => {
    running.current = true;
    setBusy(kind);
    setProblem(null);
    try {
      await work();
    } finally {
      running.current = false;
      if (alive.current) setBusy(null);
    }
  };

  /** Enters a shift the host has made, as it is. */
  const open = async (shift: DeviceShift) => {
    setBusy("entering");
    const entry = await enterShift(
      {
        local,
        pairing: { hostId, deviceId },
        online: current.current.online,
        enter,
        now: () => current.current.now(),
      },
      createdCopy(shift),
    );
    if (!alive.current) return;
    if (entry.kind === "entered") {
      current.current.onEntered(entry.shift);
      return;
    }
    if (entry.kind === "rejected") {
      current.current.onHostError(entry.error);
      return;
    }
    setProblem({ kind: "enter", number: shift.number, reason: entry.reason });
  };

  const make = async (input: DeviceShiftInput) => {
    const created = await createStationShift(
      {
        local,
        pairing: { hostId, deviceId },
        create,
        now: () => current.current.now().getTime(),
      },
      input,
    );
    if (!alive.current) return;
    if (created.kind === "rejected") {
      current.current.onHostError(created.error);
      return;
    }
    if (created.kind === "refused") {
      // The template the rule fixed is refused: the choice is the operator's
      // now, among the templates that fit.
      if (created.reason === "template") {
        update({ templateId: null, templateFixed: false });
        go("box_template");
      }
      if (created.reason === "pallet_template") {
        update({ palletTemplateId: null, palletTemplateFixed: false });
        go("pallet_template");
      }
      if (created.reason === "duplicate_template") {
        update({ duplicateTemplateId: null });
        go("duplicate_template");
      }
      setProblem({ kind: "create", reason: created.reason });
      return;
    }
    // From here the form is frozen: the shift is the host's, and the request
    // id brings it back whatever the form says.
    const matches = isShiftOfRequest(created.shift, input);
    update({ created: { shift: created.shift, matches } });
    if (!matches) {
      // A repeated request id brought back an earlier shift of other fields:
      // not the one on the screen, so not entered in silence.
      setProblem({ kind: "existing", shift: created.shift, pallets: input.pallets !== undefined });
      return;
    }
    await open(created.shift);
  };

  /** The plan and the capacity as the host takes them, or `null` with the fields' errors shown. */
  const counts = (form: Form): { plannedQty: number | null; boxCapacity: number } | null => {
    const plan = plannedQtyRule.safeParse(form.plannedQty);
    const capacity = shiftBoxCapacityRule.safeParse(form.boxCapacity);
    if (form.mode === "validation") {
      // The capacity is hidden: a valid one stands, else the host takes the product's.
      if (!plan.success) {
        setErrors({ plannedQty: t("rules.plannedQty") });
        return null;
      }
      setErrors({});
      return {
        plannedQty: toCount(plan.data),
        boxCapacity: capacity.success ? (toCount(capacity.data) ?? 0) : 0,
      };
    }
    if (!plan.success || !capacity.success) {
      setErrors({
        ...(plan.success ? {} : { plannedQty: t("rules.plannedQty") }),
        ...(capacity.success ? {} : { boxCapacity: t("rules.shiftBoxCapacity") }),
      });
      return null;
    }
    setErrors({});
    return { plannedQty: toCount(plan.data), boxCapacity: toCount(capacity.data) ?? 0 };
  };

  /** «Далее» from the details: the fields are checked before the template is chosen. */
  const next = (form: Form, to: FormView) => {
    if (form.created === null && counts(form) === null) return;
    go(to);
  };

  const submit = async (form: Form) => {
    if (ready === null || running.current) return;
    const templateId = boxTemplateOf(form, ready);
    if (templateId === null) return;
    const pallets = palletsOf(form, ready);
    if (pallets.kind === "unavailable") return;
    const prints = form.mode === "validation" && form.printDuplicate;
    if (prints && form.duplicateTemplateId === null) return;
    if (form.created !== null) {
      // Made already, here or by an earlier request: only the entry is left.
      const { shift } = form.created;
      await run("entering", () => open(shift));
      return;
    }
    const checked = counts(form);
    if (checked === null) {
      go("details");
      return;
    }
    const input: DeviceShiftInput = {
      requestId: form.requestId,
      productId: form.product.id,
      boxTemplateId: templateId,
      productionDate: form.productionDate,
      // The working day: today in the organization's zone unless the operator moved it.
      plannedDate: form.plannedDate,
      // A validation shift hides the capacity: the host takes the product's unless a valid one stands.
      ...(form.mode === "validation" && checked.boxCapacity === 0
        ? {}
        : { boxCapacity: checked.boxCapacity }),
      plannedQty: checked.plannedQty,
      ...(pallets.kind === "pallets" ? { pallets: pallets.pallets } : {}),
      ...(form.mode === "validation"
        ? {
            mode: "validation" as const,
            ...(prints && form.duplicateTemplateId !== null
              ? {
                  validationPrint: {
                    mode: "duplicate_dm" as const,
                    verification: form.verificationRequired
                      ? ("required" as const)
                      : ("none" as const),
                    templateId: form.duplicateTemplateId,
                  },
                }
              : {}),
          }
        : {}),
    };
    await run("creating", () => make(input));
  };

  /** What the shift an earlier request made says of pallets, when it differs from nothing asked. */
  const existingPallets = (shown: { shift: DeviceShift; pallets: boolean }): string => {
    const capacity = shown.shift.palletBoxCapacity;
    if (shown.shift.palletsEnabled && capacity !== undefined) {
      return t("floor.newShift.existingPallets", { capacity: formatQuantity(capacity) });
    }
    return shown.pallets ? t("floor.newShift.existingNoPallets") : "";
  };

  const problemText = (shown: Problem): string => {
    switch (shown.kind) {
      case "scan":
        return t(`floor.newShift.scan.${shown.key}`, { gtin: shown.gtin ?? "" });
      case "create":
        return t(`floor.newShift.refused.${shown.reason}`);
      case "existing":
        return t("floor.newShift.existing", {
          number: shown.shift.number,
          date: formatCivilDate(shown.shift.productionDate),
          capacity: formatQuantity(shown.shift.boxCapacity),
          plan:
            shown.shift.plannedQty === null
              ? t("floor.newShift.existingNoPlan")
              : t("floor.newShift.existingPlan", { qty: formatQuantity(shown.shift.plannedQty) }),
          pallets: existingPallets(shown),
        });
      case "enter":
        return `${t("floor.newShift.notEntered", { number: shown.number })} ${t(
          `floor.shifts.refused.${shown.reason}`,
        )}`;
    }
  };

  const productStep = () => {
    if (choices.kind === "loading")
      return <p className="new-shift__prompt">{t("floor.newShift.loading")}</p>;
    if (choices.kind === "failed") {
      return (
        <Alert
          tone="error"
          action={
            <Button size="floor" variant="secondary" onClick={() => setAttempt((v) => v + 1)}>
              {t("floor.newShift.retry")}
            </Button>
          }
        >
          {t("floor.newShift.readFailed")}
        </Alert>
      );
    }
    if (choices.kind === "not_ready")
      return <Alert tone="warn">{t("floor.newShift.notReady")}</Alert>;
    if (choices.choices.products.length === 0) {
      return <Alert tone="warn">{t("floor.newShift.noProducts")}</Alert>;
    }
    const needle = query.trim().toLocaleLowerCase("ru");
    const found =
      letters(needle) < MIN_QUERY_LETTERS
        ? []
        : choices.choices.products
            .filter((product) => product.name.toLocaleLowerCase("ru").includes(needle))
            .slice(0, RESULTS);
    return (
      <>
        <p className="new-shift__prompt">{t("floor.newShift.productPrompt")}</p>
        <Input
          size="floor"
          label={t("floor.newShift.searchLabel")}
          hint={t("floor.newShift.searchHint")}
          value={query}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => source.setManualTextEntryActive(true)}
          onBlur={() => source.setManualTextEntryActive(false)}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="new-shift__results" aria-live="polite">
          {letters(needle) >= MIN_QUERY_LETTERS && found.length === 0 ? (
            <p>{t("floor.newShift.searchEmpty")}</p>
          ) : (
            found.map((product) => (
              <Button
                key={product.id}
                size="floor"
                variant="secondary"
                fullWidth
                className="new-shift__result"
                title={t("floor.newShift.result", { name: product.name, gtin: product.gtin14 })}
                aria-label={t("floor.newShift.result", {
                  name: product.name,
                  gtin: product.gtin14,
                })}
                onClick={() => choose(product)}
              >
                {/* A long name is cut with an ellipsis, never a sideways scroll;
                    the full text is the button's title. */}
                <span className="new-shift__result-name">{product.name}</span>
                <span className="new-shift__result-gtin">{` — ${product.gtin14}`}</span>
              </Button>
            ))
          )}
        </div>
      </>
    );
  };

  /** Step 1, the cloud's `found`: the product, the pallets, the date, the counts. */
  const detailsView = (form: Form, from: NewShiftChoices) => {
    const palletCapacity = palletCapacityOffered(form.product, from.palletTemplates);
    const zoneKnown = from.timeZone !== null && isKnownTimeZone(from.timeZone);
    // Once the host has made the shift its fields are not the form's to change.
    const frozen = busy !== null || form.created !== null;
    return (
      <>
        <Card className="new-shift__product" padding="var(--sp-3)">
          <ProductPanel
            local={local}
            productId={form.product.id}
            gtin={form.product.gtin14}
            className="new-shift__product-photo"
            fallback={
              <span className="new-shift__product-monogram" aria-hidden="true">
                {productMonogram(form.product.name)}
              </span>
            }
          />
          <div className="new-shift__product-text">
            <h3 title={form.product.name}>{form.product.name}</h3>
            <div className="new-shift__code">{form.product.gtin14}</div>
          </div>
        </Card>
        {/* The shift's mode and the duplicate print, as the cloud's two-column
            `new-shift__modes` rows under the product (plan РЕЖ). */}
        <div className="new-shift__group">
          <p className="new-shift__label">{t("floor.newShift.mode")}</p>
          <div className="new-shift__modes" role="group" aria-label={t("floor.newShift.mode")}>
            <Button
              size="floor"
              fullWidth
              variant={form.mode === "validation" ? "primary" : "secondary"}
              aria-pressed={form.mode === "validation"}
              disabled={frozen}
              onClick={() => update({ mode: "validation" })}
            >
              {t("floor.newShift.modeValidation")}
            </Button>
            <Button
              size="floor"
              fullWidth
              variant={form.mode === "aggregation" ? "primary" : "secondary"}
              aria-pressed={form.mode === "aggregation"}
              disabled={frozen}
              onClick={() => update({ mode: "aggregation" })}
            >
              {t("floor.newShift.modeAggregation")}
            </Button>
          </div>
        </div>
        {form.mode === "validation" && (
          <div className="new-shift__group">
            <p className="new-shift__label">{t("floor.newShift.printDuplicate")}</p>
            <div
              className="new-shift__modes"
              role="group"
              aria-label={t("floor.newShift.printDuplicate")}
            >
              <Button
                size="floor"
                fullWidth
                variant={form.printDuplicate ? "secondary" : "primary"}
                aria-pressed={!form.printDuplicate}
                disabled={frozen}
                onClick={() => update({ printDuplicate: false })}
              >
                {t("floor.newShift.no")}
              </Button>
              <Button
                size="floor"
                fullWidth
                variant={form.printDuplicate ? "primary" : "secondary"}
                aria-pressed={form.printDuplicate}
                disabled={frozen}
                onClick={() => update({ printDuplicate: true })}
              >
                {t("floor.newShift.yes")}
              </Button>
            </div>
            <p className="new-shift__hint">
              {t(
                form.printDuplicate
                  ? "floor.newShift.printDuplicateHint"
                  : "floor.newShift.validationBoxHint",
              )}
            </p>
          </div>
        )}
        {form.mode === "aggregation" && palletCapacity !== null && (
          <div className="new-shift__group">
            <div className="new-shift__modes" role="group" aria-label={t("floor.newShift.pallets")}>
              <Button
                size="floor"
                fullWidth
                variant={form.pallets ? "secondary" : "primary"}
                aria-pressed={!form.pallets}
                disabled={frozen}
                onClick={() => update({ pallets: false })}
              >
                {t("floor.newShift.withoutPallets")}
              </Button>
              <Button
                size="floor"
                fullWidth
                variant={form.pallets ? "primary" : "secondary"}
                aria-pressed={form.pallets}
                disabled={frozen}
                onClick={() => update({ pallets: true })}
              >
                {t("floor.newShift.withPallets")}
              </Button>
            </div>
            {form.pallets && (
              <p className="new-shift__hint">
                {t("floor.newShift.palletCapacity", { quantity: formatQuantity(palletCapacity) })}
              </p>
            )}
          </div>
        )}
        {/* The date and the two counts in one row: step 1 keeps room under the
            product for plan РЕЖ's rows and still fits 1280×800 unscrolled. */}
        <div className="new-shift__counts">
          <div className="new-shift__date">
            <DatePicker
              label={t("floor.newShift.productionDate")}
              {...(zoneKnown ? {} : { hint: t("floor.newShift.pcDate") })}
              value={form.productionDate}
              locale="ru-RU"
              calendarLabel={t("floor.newShift.calendar")}
              previousMonthLabel={t("floor.newShift.previousMonth")}
              nextMonthLabel={t("floor.newShift.nextMonth")}
              disabled={frozen}
              // The production date is required: clearing it keeps the date shown.
              onValueChange={(value) => {
                if (value !== undefined) update({ productionDate: value });
              }}
            />
          </div>
          <div className="new-shift__date">
            <DatePicker
              label={t("floor.newShift.plannedDate")}
              value={form.plannedDate}
              locale="ru-RU"
              calendarLabel={t("floor.newShift.calendar")}
              previousMonthLabel={t("floor.newShift.previousMonth")}
              nextMonthLabel={t("floor.newShift.nextMonth")}
              disabled={frozen}
              // The shift date is required too: clearing it keeps the date shown.
              onValueChange={(value) => {
                if (value !== undefined) update({ plannedDate: value });
              }}
            />
          </div>
          <Input
            size="floor"
            label={t("floor.newShift.plannedQty")}
            hint={t("floor.newShift.optional")}
            inputMode="numeric"
            value={form.plannedQty}
            disabled={frozen}
            {...(errors.plannedQty === undefined ? {} : { error: errors.plannedQty })}
            onChange={(event) => update({ plannedQty: event.currentTarget.value })}
          />
          {form.mode === "aggregation" && (
            <Input
              size="floor"
              label={t("floor.newShift.boxCapacity")}
              inputMode="numeric"
              value={form.boxCapacity}
              disabled={frozen}
              {...(errors.boxCapacity === undefined ? {} : { error: errors.boxCapacity })}
              onChange={(event) => update({ boxCapacity: event.currentTarget.value })}
            />
          )}
        </div>
      </>
    );
  };

  /**
   * Steps 2 and 3, the cloud's template steps: the templates that fit with the
   * chosen one's label beside them. A template the rule fixed is shown, not
   * offered (decision 7): the choice is the operator's only where the rule
   * leaves several.
   */
  const templateView = (
    form: Form,
    from: NewShiftChoices,
    purpose: "box" | "pallet" | "duplicate",
  ) => {
    const box = purpose === "box";
    const duplicate = purpose === "duplicate";
    const fitting = box
      ? fittingTemplates(form.product, from.templates)
      : duplicate
        ? fittingDuplicateTemplates(form.product, from.duplicateTemplates)
        : fittingPalletTemplates(form.product, from.palletTemplates);
    const chosenId = box
      ? form.templateId
      : duplicate
        ? form.duplicateTemplateId
        : form.palletTemplateId;
    const fixed = box ? form.templateFixed : duplicate ? false : form.palletTemplateFixed;
    const chosen = fitting.find((template) => template.id === chosenId) ?? null;
    const frozen = busy !== null || form.created !== null;
    const spec = chosen === null ? null : (specs?.get(chosen.id) ?? null);
    const label = box
      ? "floor.newShift.template"
      : duplicate
        ? "floor.newShift.duplicateTemplate"
        : "floor.newShift.palletTemplate";
    return (
      <>
        <h3 className="new-shift__template-title">{t(label)}</h3>
        {fitting.length === 0 ? (
          <Alert tone="error">
            {t(duplicate ? "floor.newShift.noDuplicateTemplate" : "floor.newShift.noTemplate")}
          </Alert>
        ) : (
          <div className="new-shift__template-grid">
            <div className="new-shift__template-choices">
              {chosen !== null ? (
                <p className="new-shift__value">
                  {t(
                    box
                      ? "floor.newShift.templateChosen"
                      : duplicate
                        ? "floor.newShift.duplicateTemplateChosen"
                        : "floor.newShift.palletTemplateChosen",
                    { name: chosen.name },
                  )}
                </p>
              ) : (
                <p className="new-shift__label">
                  {t(
                    box
                      ? "floor.newShift.templateChoose"
                      : duplicate
                        ? "floor.newShift.duplicateTemplateChoose"
                        : "floor.newShift.palletTemplateChoose",
                  )}
                </p>
              )}
              {!(fixed && chosen !== null) && (
                <div className="new-shift__template-list" role="group" aria-label={t(label)}>
                  {fitting.map((template) => (
                    <Button
                      key={template.id}
                      size="floor"
                      fullWidth
                      variant={template.id === chosenId ? "primary" : "secondary"}
                      aria-pressed={template.id === chosenId}
                      disabled={frozen}
                      onClick={() =>
                        update(
                          box
                            ? { templateId: template.id }
                            : duplicate
                              ? { duplicateTemplateId: template.id }
                              : { palletTemplateId: template.id },
                        )
                      }
                    >
                      <span className="new-shift__ellipsis" title={template.name}>
                        {template.name}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
            {duplicate ? (
              <div className="new-shift__verification">
                <p className="new-shift__label">{t("floor.newShift.verification")}</p>
                <div
                  className="new-shift__modes"
                  role="group"
                  aria-label={t("floor.newShift.verification")}
                >
                  <Button
                    size="floor"
                    fullWidth
                    variant={form.verificationRequired ? "secondary" : "primary"}
                    aria-pressed={!form.verificationRequired}
                    disabled={frozen}
                    onClick={() => update({ verificationRequired: false })}
                  >
                    {t("floor.newShift.no")}
                  </Button>
                  <Button
                    size="floor"
                    fullWidth
                    variant={form.verificationRequired ? "primary" : "secondary"}
                    aria-pressed={form.verificationRequired}
                    disabled={frozen}
                    onClick={() => update({ verificationRequired: true })}
                  >
                    {t("floor.newShift.yes")}
                  </Button>
                </div>
                <p className="new-shift__hint">
                  {t(
                    form.verificationRequired
                      ? "floor.newShift.verificationRequiredHint"
                      : "floor.newShift.verificationNoneHint",
                  )}
                </p>
              </div>
            ) : (
              <div className="new-shift__preview">
                {spec !== null ? (
                  <TemplatePreview spec={spec} purpose={purpose} product={form.product} />
                ) : (
                  <p className="new-shift__hint">
                    {t(
                      chosen === null ? "floor.newShift.previewPick" : "floor.newShift.previewNone",
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </>
    );
  };

  const formShown = step.kind === "form" && ready !== null ? step : null;
  // The problem and the request in progress, said together in one polite
  // region that is there before either. Not an alert as well
  // (`role="presentation"` drops the component's own role): inside this
  // region it would be read twice.
  const messageSlot = (
    <div className="new-shift__message" aria-live="polite">
      {problem !== null && (
        <Alert tone="error" role="presentation">
          {problemText(problem)}
        </Alert>
      )}
      {busy !== null && <p>{t(`floor.newShift.${busy}`)}</p>}
    </div>
  );
  // Never held by a request: one that never settles must not trap the station here.
  const back = (
    <Button size="floor" fullWidth variant="secondary" onClick={onBack}>
      {t("floor.newShift.back")}
    </Button>
  );
  const otherProduct = (
    <Button
      size="floor"
      fullWidth
      variant="secondary"
      disabled={busy !== null}
      onClick={() => {
        setProblem(null);
        setStep({ kind: "product" });
      }}
    >
      {t("floor.newShift.otherProduct")}
    </Button>
  );

  const formActions = (shown: { form: Form; view: FormView }, from: NewShiftChoices) => {
    const { form, view } = shown;
    const order = viewsOf(form, from);
    const at = Math.max(0, order.indexOf(view));
    const following = order[at + 1];
    const previous = order[at - 1] ?? "details";
    const prints = form.mode === "validation" && form.printDuplicate;
    return (
      <>
        {following !== undefined ? (
          <Button
            size="floor"
            fullWidth
            disabled={
              busy !== null ||
              (view === "box_template" && form.templateId === null) ||
              (view === "pallet_template" && form.palletTemplateId === null)
            }
            onClick={() => (view === "details" ? next(form, following) : go(following))}
          >
            {t("floor.newShift.next")}
          </Button>
        ) : (
          <Button
            size="floor"
            fullWidth
            loading={busy !== null}
            disabled={
              !online ||
              boxTemplateOf(form, from) === null ||
              palletsOf(form, from).kind === "unavailable" ||
              (prints && form.duplicateTemplateId === null)
            }
            onClick={() => {
              if (view === "details" && form.created === null && counts(form) === null) return;
              void submit(form);
            }}
          >
            {form.created === null
              ? t("floor.newShift.create")
              : t("floor.newShift.openCreated", { number: form.created.shift.number })}
          </Button>
        )}
        {view !== "details" && (
          <Button
            size="floor"
            fullWidth
            variant="secondary"
            disabled={busy !== null}
            onClick={() => go(previous)}
          >
            {t("floor.newShift.previousStep")}
          </Button>
        )}
        {otherProduct}
        {back}
      </>
    );
  };

  const formBody = (shown: { form: Form; view: FormView }, from: NewShiftChoices) => {
    if (shown.view === "box_template") return templateView(shown.form, from, "box");
    if (shown.view === "pallet_template") return templateView(shown.form, from, "pallet");
    if (shown.view === "duplicate_template") return templateView(shown.form, from, "duplicate");
    return detailsView(shown.form, from);
  };

  return (
    <FloorScreen
      className="new-shift"
      title={t("floor.newShift.title")}
      actions={
        <FloorFooter ariaLabel={t("floor.newShift.actions")}>
          {formShown !== null && ready !== null ? (
            formActions(formShown, ready)
          ) : (
            <>
              {/* The cloud's first half holds «Открыть» for a typed GTIN; here a
                  product is chosen by a scan or from the results, so it stays empty. */}
              <span className="new-shift__spacer" aria-hidden="true" />
              {back}
            </>
          )}
        </FloorFooter>
      }
    >
      {formShown !== null && ready !== null ? (
        <section
          className={`new-shift__panel new-shift__panel--${formShown.view === "details" ? "found" : "template"}`}
        >
          {/* Keyed per view: a scroller reused across the steps kept the last one's scroll. */}
          <div key={formShown.view} className="new-shift__fields">
            {formBody(formShown, ready)}
            {!online && formShown.form.created === null && (
              <p className="new-shift__hint">{t("floor.newShift.needsLink")}</p>
            )}
          </div>
          {messageSlot}
        </section>
      ) : (
        <section className="new-shift__panel new-shift__panel--input">
          <div key="search" className="new-shift__search">
            {productStep()}
          </div>
          {messageSlot}
        </section>
      )}
    </FloorScreen>
  );
}
