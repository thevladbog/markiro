import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input } from "@markiro/ui";

import type { DeviceShift, DeviceShiftCreate, EnteredShift } from "../../host/protocol.js";
import { suggestBoxTemplate } from "../../lib/box-template-choice.js";
import { civilToday, isKnownTimeZone } from "../../lib/civil-date.js";
import { plannedQtyRule, shiftBoxCapacityRule, toCount } from "../../lib/rules.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { ScanSource } from "../scan-source.js";
import {
  createdCopy,
  createStationShift,
  findScannedProduct,
  fittingTemplates,
  readNewShiftChoices,
  type CreateRefusal,
  type NewShiftChoices,
  type ShiftProduct,
} from "./new-shift.js";
import type { WorkShift } from "./shift-copies.js";
import { enterShift, type EntryRefusal } from "./shift-entry.js";
import { addCivilDays, formatCivilDate } from "./shift-text.js";

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
  enter: (shiftId: string) => Promise<EnteredShift>;
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
  plannedQty: string;
  boxCapacity: string;
}

type Problem =
  | { kind: "scan"; key: string; gtin: string | null }
  | { kind: "create"; reason: CreateRefusal }
  | { kind: "enter"; number: string; reason: EntryRefusal };

type Step = { kind: "product" } | { kind: "form"; form: Form };

function letters(text: string): number {
  return Array.from(text).filter((character) => /\p{L}/u.test(character)).length;
}

/**
 * A shift created on the station (stage 2a spec §5.7.2, the cloud station's
 * `NewShift` without its cloud parts): the product by its barcode or code of
 * marking, or by name, among the products in use; the box template by the
 * rule of decision 7 (`suggestBoxTemplate`), chosen by the operator when the
 * rule leaves several; the production date, today in the organization's
 * zone; the plan, optional; the capacity from the product. It needs the host:
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
      setProblem(null);
      setErrors({});
      setStep({
        kind: "form",
        form: {
          product,
          requestId: current.current.newRequestId(),
          templateId: fixed,
          templateFixed: fixed !== null,
          productionDate: civilToday(ready.timeZone, current.current.now()),
          plannedQty: "",
          boxCapacity: product.boxCapacity === null ? "" : String(product.boxCapacity),
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
      previous.kind === "form" ? { kind: "form", form: { ...previous.form, ...change } } : previous,
    );

  const submit = async (form: Form) => {
    if (running.current || form.templateId === null) return;
    const plan = plannedQtyRule.safeParse(form.plannedQty);
    const capacity = shiftBoxCapacityRule.safeParse(form.boxCapacity);
    if (!plan.success || !capacity.success) {
      setErrors({
        ...(plan.success ? {} : { plannedQty: t("rules.plannedQty") }),
        ...(capacity.success ? {} : { boxCapacity: t("rules.shiftBoxCapacity") }),
      });
      return;
    }
    setErrors({});
    running.current = true;
    setBusy("creating");
    setProblem(null);
    try {
      const created = await createStationShift(
        {
          local,
          pairing: { hostId, deviceId },
          create,
          now: () => current.current.now().getTime(),
        },
        {
          requestId: form.requestId,
          productId: form.product.id,
          boxTemplateId: form.templateId,
          productionDate: form.productionDate,
          boxCapacity: toCount(capacity.data) ?? 0,
          plannedQty: toCount(plan.data),
        },
      );
      if (!alive.current) return;
      if (created.kind === "rejected") {
        current.current.onHostError(created.error);
        return;
      }
      if (created.kind === "refused") {
        setProblem({ kind: "create", reason: created.reason });
        return;
      }
      setBusy("entering");
      const entry = await enterShift(
        {
          local,
          pairing: { hostId, deviceId },
          online: current.current.online,
          enter,
          now: () => current.current.now(),
        },
        createdCopy(created.shift),
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
      setProblem({ kind: "enter", number: created.shift.number, reason: entry.reason });
    } finally {
      running.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const problemText = (shown: Problem): string => {
    switch (shown.kind) {
      case "scan":
        return t(`floor.newShift.scan.${shown.key}`, { gtin: shown.gtin ?? "" });
      case "create":
        return t(`floor.newShift.refused.${shown.reason}`);
      case "enter":
        return `${t("floor.newShift.notEntered", { number: shown.number })} ${t(
          `floor.shifts.refused.${shown.reason}`,
        )}`;
    }
  };

  const productStep = () => {
    if (choices.kind === "loading") return <p>{t("floor.newShift.loading")}</p>;
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
        <p className="floor-sign-in__prompt">{t("floor.newShift.productPrompt")}</p>
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
        <div className="floor-sign-in__results" aria-live="polite">
          {letters(needle) >= MIN_QUERY_LETTERS && found.length === 0 ? (
            <p>{t("floor.newShift.searchEmpty")}</p>
          ) : (
            found.map((product) => (
              <Button
                key={product.id}
                size="floor"
                variant="secondary"
                fullWidth
                onClick={() => choose(product)}
              >
                {t("floor.newShift.result", { name: product.name, gtin: product.gtin14 })}
              </Button>
            ))
          )}
        </div>
      </>
    );
  };

  const formStep = (form: Form, from: NewShiftChoices) => {
    const fitting = fittingTemplates(form.product, from.templates);
    const chosen = fitting.find((template) => template.id === form.templateId) ?? null;
    const zoneKnown = from.timeZone !== null && isKnownTimeZone(from.timeZone);
    return (
      <>
        <p className="shift-card__product">
          {t("floor.newShift.product", { name: form.product.name, gtin: form.product.gtin14 })}
        </p>
        {fitting.length === 0 ? (
          <Alert tone="error">{t("floor.newShift.noTemplate")}</Alert>
        ) : form.templateFixed && chosen !== null ? (
          <p>{t("floor.newShift.templateChosen", { name: chosen.name })}</p>
        ) : (
          <div className="new-shift__choice" role="group" aria-label={t("floor.newShift.template")}>
            {chosen === null && <p>{t("floor.newShift.templateChoose")}</p>}
            {fitting.map((template) => (
              <Button
                key={template.id}
                size="floor"
                variant={template.id === form.templateId ? "primary" : "secondary"}
                aria-pressed={template.id === form.templateId}
                disabled={busy !== null}
                onClick={() => update({ templateId: template.id })}
              >
                {template.name}
              </Button>
            ))}
          </div>
        )}
        <div
          className="new-shift__date"
          role="group"
          aria-label={t("floor.newShift.productionDate")}
        >
          <p className="floor-sign-in__prompt">
            {t("floor.newShift.productionDateValue", {
              date: formatCivilDate(form.productionDate),
            })}
          </p>
          {!zoneKnown && <p className="shift-card__hint">{t("floor.newShift.pcDate")}</p>}
          <div className="standalone-form__actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => update({ productionDate: addCivilDays(form.productionDate, -1) })}
            >
              {t("floor.newShift.dayBefore")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => update({ productionDate: addCivilDays(form.productionDate, 1) })}
            >
              {t("floor.newShift.dayAfter")}
            </Button>
          </div>
        </div>
        <Input
          size="floor"
          label={t("floor.newShift.plannedQty")}
          hint={t("floor.newShift.optional")}
          inputMode="numeric"
          value={form.plannedQty}
          disabled={busy !== null}
          {...(errors.plannedQty === undefined ? {} : { error: errors.plannedQty })}
          onChange={(event) => update({ plannedQty: event.currentTarget.value })}
        />
        <Input
          size="floor"
          label={t("floor.newShift.boxCapacity")}
          inputMode="numeric"
          value={form.boxCapacity}
          disabled={busy !== null}
          {...(errors.boxCapacity === undefined ? {} : { error: errors.boxCapacity })}
          onChange={(event) => update({ boxCapacity: event.currentTarget.value })}
        />
        <div className="standalone-form__actions">
          <Button
            size="floor"
            loading={busy !== null}
            disabled={!online || form.templateId === null}
            onClick={() => void submit(form)}
          >
            {t("floor.newShift.create")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              setProblem(null);
              setStep({ kind: "product" });
            }}
          >
            {t("floor.newShift.otherProduct")}
          </Button>
        </div>
        {!online && <p className="shift-card__hint">{t("floor.newShift.needsLink")}</p>}
      </>
    );
  };

  return (
    <Card className="standalone-card shift-list" title={t("floor.newShift.title")} titleAs="h2">
      <div className="standalone-form">
        <div className="floor-sign-in__message" aria-live="polite">
          {problem !== null && <Alert tone="error">{problemText(problem)}</Alert>}
          {busy !== null && <p>{t(`floor.newShift.${busy}`)}</p>}
        </div>
        {step.kind === "form" && ready !== null ? formStep(step.form, ready) : productStep()}
        <div className="standalone-form__actions">
          {/* Never held by a request: one that never settles must not trap the station here. */}
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t("floor.newShift.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
