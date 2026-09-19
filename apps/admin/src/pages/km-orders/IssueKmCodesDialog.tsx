import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { KM_LABEL_TEMPLATE_NAME } from "@markiro/domain";
import { Alert, Button, Input, Modal, RadioGroup, Select } from "@markiro/ui";

import { useChzProductGroups } from "../catalog/api.js";
import { useLabelTemplates, type LabelTemplateSummaryDto } from "../labels/api.js";
import {
  kmIssueFileUrl,
  kmIssuePrintPath,
  kmIssueTooManyAvailable,
  useIssueKmCodes,
} from "./api.js";
import {
  KM_ORDER_MAX_QUANTITY,
  KM_PRINT_ISSUE_MAX_COUNT,
  type KmIssueFormat,
  type KmIssueKind,
  type KmOrder,
} from "./schemas.js";

const FORM_ID = "km-issue-form";
const COUNT_FIELD_ID = "km-issue-count-field";
const TEMPLATE_FIELD_ID = "km-issue-template-field";

/** Round amounts an office asks for; «Все» is computed from what is left. */
const QUICK_COUNTS = [100, 500, 1000] as const;

/**
 * Whether a label template may print the marking codes of this order: the KM
 * purpose, and either a universal template or one scoped to the order's own
 * ЧЗ product group. Same category rule as `isBoxLabelTemplateEligible` /
 * `isPalletLabelTemplateEligible` in `@markiro/domain`, which are gated on
 * their own purposes; `enabled` is already filtered by the query.
 */
function isKmTemplateEligible(
  template: LabelTemplateSummaryDto,
  chzProductGroupCode: number | null,
): boolean {
  if (template.purpose !== "product_km" || !template.enabled) return false;
  if (template.chzProductGroupCodes === null) return true;
  return (
    chzProductGroupCode !== null && template.chzProductGroupCodes.includes(chzProductGroupCode)
  );
}

export interface IssueKmCodesDialogProps {
  open: boolean;
  mode: KmIssueKind;
  order: KmOrder;
  onClose: () => void;
}

/**
 * «Выгрузить» / «Печать» -- the two ways codes leave an order, and the only
 * place a range is chosen. An issue permanently consumes the codes it names,
 * so the dialog states the exact range before it is committed: the server
 * hands out the lowest still-available codes, starting at `issuedCount + 1`,
 * and the preview is that same arithmetic rather than a hopeful guess.
 *
 * The count is bounded here by what the order still holds (and, for a print
 * batch, by `KM_PRINT_ISSUE_MAX_COUNT`) so the preview can never promise a
 * range wider than the office can actually get. The server re-checks under a
 * row lock and answers `CHZ_KM_ISSUE_TOO_MANY` with its own count, which is
 * the number reported back -- this card's copy may be seconds stale.
 */
export function IssueKmCodesDialog({ open, mode, order, onClose }: IssueKmCodesDialogProps) {
  const { t, i18n } = useTranslation();
  const issueCodes = useIssueKmCodes();
  // Both reference reads are made in either mode (the Rules of Hooks leave no
  // conditional way to skip them), and both are the session-cached queries the
  // catalog and label screens already use, so an export dialog reuses whatever
  // those screens put in the cache instead of asking for anything new.
  const groups = useChzProductGroups();
  const templates = useLabelTemplates({ enabled: "true" });
  const [count, setCount] = useState("");
  const [format, setFormat] = useState<KmIssueFormat>("txt");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [tooMany, setTooMany] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const maxCount = Math.min(
    order.availableForIssue,
    mode === "print" ? KM_PRINT_ISSUE_MAX_COUNT : KM_ORDER_MAX_QUANTITY,
  );
  const parsedCount = /^\d+$/.test(count.trim()) ? Number(count.trim()) : Number.NaN;
  const countInRange = parsedCount >= 1 && parsedCount <= maxCount;

  const groupCode =
    groups.data?.find((group) => group.alias === order.productGroupAlias)?.code ?? null;
  const eligibleTemplates = useMemo(
    () => (templates.data ?? []).filter((template) => isKmTemplateEligible(template, groupCode)),
    [groupCode, templates.data],
  );
  // Derived during render rather than pushed into state by an effect: `null`
  // means "the operator has not chosen", which resolves to the stock KM label
  // (the one every tenant is seeded with) and otherwise to whatever else is
  // eligible.
  const stockTemplate =
    eligibleTemplates.find((template) => template.name === KM_LABEL_TEMPLATE_NAME) ??
    eligibleTemplates[0];
  const selectedTemplateId = templateId ?? stockTemplate?.id ?? "";
  const templatesPending = templates.isPending || groups.isPending;

  const countError =
    countInRange || (count.trim() === "" && !submitted)
      ? null
      : t("pages.kmOrders.issue.countRange", { max: number.format(maxCount) });
  const templateError =
    mode === "print" && submitted && selectedTemplateId === ""
      ? t("pages.kmOrders.issue.templateRequired")
      : null;
  const templateHint = templates.isError
    ? t("pages.kmOrders.issue.templateLoadError")
    : !templatesPending && eligibleTemplates.length === 0
      ? t("pages.kmOrders.issue.templateEmpty")
      : null;

  const changeCount = (value: string) => {
    setCount(value);
    // The server's refusal named a count that no longer applies once the
    // operator picks a different one.
    setTooMany(null);
    setSubmitError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setTooMany(null);
    setSubmitError(null);
    if (!countInRange || (mode === "print" && selectedTemplateId === "")) {
      // Announce nothing and the office re-clicks the same button: move focus
      // to the first invalid control, in form order.
      document.getElementById(countInRange ? TEMPLATE_FIELD_ID : COUNT_FIELD_ID)?.focus();
      return;
    }

    try {
      const issue = await issueCodes.mutateAsync(
        mode === "export"
          ? { orderId: order.id, kind: "export", format, count: parsedCount }
          : { orderId: order.id, kind: "print", count: parsedCount },
      );
      if (mode === "export") {
        // The endpoint answers with `Content-Disposition: attachment`, so this
        // downloads the file and leaves the cabinet where it is.
        window.location.assign(kmIssueFileUrl(order.id, issue.id));
      } else {
        const template = encodeURIComponent(selectedTemplateId);
        window.open(`${kmIssuePrintPath(order.id, issue.id)}?template=${template}`, "_blank");
      }
      // The parent unmounts this dialog, so no state is reset after here.
      onClose();
    } catch (caught) {
      const available = kmIssueTooManyAvailable(caught);
      if (available !== null) {
        setTooMany(available);
        return;
      }
      setSubmitError(t("pages.kmOrders.issue.genericError"));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={t(
        mode === "export" ? "pages.kmOrders.issue.exportTitle" : "pages.kmOrders.issue.printTitle",
      )}
      width={520}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={issueCodes.isPending}>
            {t(
              mode === "export"
                ? "pages.kmOrders.issue.submitExport"
                : "pages.kmOrders.issue.submitPrint",
            )}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="mk-km-issue-form"
        // Every refusal is reported through the field's own error text, in the
        // cabinet's language; the browser's untranslated bubbles would fire
        // first and say something else.
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        {tooMany !== null ? (
          <Alert tone="error" role="alert">
            {t("pages.kmOrders.issue.tooMany", { available: number.format(tooMany) })}
          </Alert>
        ) : null}
        {submitError !== null ? (
          <Alert tone="error" role="alert">
            {submitError}
          </Alert>
        ) : null}
        <Input
          id={COUNT_FIELD_ID}
          type="number"
          inputMode="numeric"
          min={1}
          max={maxCount}
          mono
          label={t("pages.kmOrders.issue.count")}
          placeholder={t("pages.kmOrders.issue.countPlaceholder")}
          value={count}
          onChange={(event) => changeCount(event.target.value)}
          {...(countError !== null
            ? { error: countError }
            : {
                hint:
                  mode === "print"
                    ? t("pages.kmOrders.issue.countHintPrint", {
                        available: number.format(order.availableForIssue),
                        max: number.format(KM_PRINT_ISSUE_MAX_COUNT),
                      })
                    : t("pages.kmOrders.issue.countHint", {
                        available: number.format(order.availableForIssue),
                      }),
              })}
        />
        <div
          className="mk-km-issue-quick"
          role="group"
          aria-label={t("pages.kmOrders.issue.quickLabel")}
        >
          {QUICK_COUNTS.map((quick) => (
            <Button
              key={quick}
              type="button"
              variant="secondary"
              size="compact"
              disabled={quick > maxCount}
              onClick={() => changeCount(String(quick))}
            >
              {number.format(quick)}
            </Button>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={maxCount < 1}
            onClick={() => changeCount(String(maxCount))}
          >
            {t("pages.kmOrders.issue.quickAll")}
          </Button>
        </div>
        <p className="mk-km-issue-range">
          <span className="mk-km-issue-range__label">{t("pages.kmOrders.issue.rangeLabel")}</span>
          <span className="mk-km-issue-range__value">
            {countInRange
              ? t("pages.kmOrders.range", {
                  from: number.format(order.issuedCount + 1),
                  to: number.format(order.issuedCount + parsedCount),
                })
              : t("pages.kmOrders.issue.rangePlaceholder")}
          </span>
        </p>
        {mode === "export" ? (
          <RadioGroup
            label={t("pages.kmOrders.issue.format")}
            value={format}
            onValueChange={(value) => setFormat(value === "csv" ? "csv" : "txt")}
            options={[
              { value: "txt", label: t("pages.kmOrders.issue.formatTxt") },
              { value: "csv", label: t("pages.kmOrders.issue.formatCsv") },
            ]}
          />
        ) : (
          <>
            <Select
              id={TEMPLATE_FIELD_ID}
              label={t("pages.kmOrders.issue.template")}
              value={selectedTemplateId}
              onValueChange={setTemplateId}
              placeholder={t("pages.kmOrders.issue.templatePlaceholder")}
              disabled={templatesPending || templates.isError}
              options={eligibleTemplates.map((template) => ({
                value: template.id,
                label: template.name,
              }))}
              {...(templateError !== null ? { error: templateError } : {})}
              {...(templateHint !== null ? { hint: templateHint } : {})}
            />
            <p className="mk-km-issue-note">{t("pages.kmOrders.issue.printerNote")}</p>
          </>
        )}
      </form>
    </Modal>
  );
}
