import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, Select, StatusChip, Textarea } from "@markiro/ui";
import {
  COVERAGE_STATUSES,
  UOM_CODES_V1,
  assessCoverageReview,
  validateCoverageReview,
} from "@markiro/domain";
import {
  putProductTraceabilityProfileSchema,
  type ProductTraceabilityProfile,
  type UpsertProductTraceabilityProfile,
  type UsProduct,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import "./profile.css";

const fields = [
  "productName",
  "brandName",
  "commodity",
  "variety",
  "packagingSizeValue",
  "packagingSizeUom",
  "packagingStyle",
  "defaultQuantityUom",
  "coverageStatus",
  "coverageRationale",
  "ftlCategory",
  "ftlSourceUrl",
  "ftlSourceVersion",
] as const satisfies readonly (keyof UpsertProductTraceabilityProfile)[];
type Field = (typeof fields)[number];
type Draft = Record<Field, string>;
const coverageFields = [
  "coverageStatus",
  "coverageRationale",
  "ftlCategory",
  "ftlSourceUrl",
  "ftlSourceVersion",
] as const;
const draftOf = (profile: ProductTraceabilityProfile): Draft => ({
  productName: profile.productName,
  brandName: profile.brandName ?? "",
  commodity: profile.commodity ?? "",
  variety: profile.variety ?? "",
  packagingSizeValue: profile.packagingSizeValue ?? "",
  packagingSizeUom: profile.packagingSizeUom ?? "",
  packagingStyle: profile.packagingStyle ?? "",
  defaultQuantityUom: profile.defaultQuantityUom ?? "",
  coverageStatus: profile.coverageStatus,
  coverageRationale: profile.coverageRationale ?? "",
  ftlCategory: profile.ftlCategory ?? "",
  ftlSourceUrl: profile.ftlSourceUrl ?? "",
  ftlSourceVersion: profile.ftlSourceVersion ?? "",
});
export type ProductProfileContext = {
  canManageQa: boolean;
  profileCode: "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
  timeZone: string;
};
type Props = MasterDataViewProps &
  ProductProfileContext & { product: UsProduct; onBack: () => void };

export function ProductProfileView({
  product,
  client,
  profileCode,
  timeZone,
  canWrite,
  canManageQa,
  beginMutation,
  onDirtyChange,
  onForbidden,
  onSessionLost,
  onBack,
}: Props) {
  const { t, i18n } = useTranslation();
  const [saved, setSaved] = useState<ProductTraceabilityProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const alive = useRef(true);
  const run = useRef(0);
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const generic = profileCode === "US_GENERIC_LOT_TRACEABILITY";
  const baseline = saved ? draftOf(saved) : null;
  const dirty =
    draft !== null && baseline !== null && fields.some((field) => draft[field] !== baseline[field]);
  const qaChanged =
    !canManageQa &&
    draft !== null &&
    baseline !== null &&
    coverageFields.some((field) => draft[field] !== baseline[field]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (failure || conflict) alert.current?.focus();
  }, [failure, conflict, errors]);
  useEffect(() => {
    if (savedNotice) status.current?.focus();
  }, [savedNotice]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  const load = useCallback(async () => {
    const current = ++run.current;
    busy.current = true;
    setPending(true);
    setSavedNotice(false);
    try {
      const value = await client.getProductProfile(product.id);
      if (!alive.current || run.current !== current) return;
      if (
        validateCoverageReview(value, profileCode).length ||
        (profileCode === "US_GENERIC_LOT_TRACEABILITY" && value.reviewedBy !== null)
      )
        throw new UsClientError("invalid_response");
      setSaved(value);
      setDraft(draftOf(value));
      setErrors({});
      setFailure(null);
      setConflict(false);
      heading.current?.focus();
    } catch (error) {
      if (!alive.current || run.current !== current) return;
      setFailure("loadError");
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
    } finally {
      if (alive.current && run.current === current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [client, product.id, profileCode, onForbidden, onSessionLost]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      run.current += 1;
    };
  }, [load]);

  function back() {
    if (busy.current || (dirty && !window.confirm(t("md.discardConfirm")))) return;
    onBack();
  }
  function reload() {
    if (busy.current || (dirty && !window.confirm(t("md.discardConfirm")))) return;
    void load();
  }
  function change(field: Field, value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : null));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setFailure(null);
    setSavedNotice(false);
  }
  function discardCoverage() {
    if (
      busy.current ||
      !qaChanged ||
      !draft ||
      !baseline ||
      !window.confirm(t("productProfile.discardCoverageConfirm"))
    )
      return;
    setDraft({
      ...draft,
      ...Object.fromEntries(coverageFields.map((field) => [field, baseline[field]])),
    });
    setErrors((current) => {
      const next = { ...current };
      for (const field of coverageFields) delete next[field];
      return next;
    });
    setFailure(null);
    heading.current?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      busy.current ||
      !canWrite ||
      qaChanged ||
      conflict ||
      !draft ||
      !saved ||
      (saved.revision > 0 && !dirty)
    )
      return;
    const parsed = putProductTraceabilityProfileSchema.safeParse({
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          field === "productName" || field === "coverageStatus"
            ? draft[field]
            : draft[field].trim() || null,
        ]),
      ),
      expectedRevision: saved.revision,
    });
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = fields.find((item) => item === issue.path[0]);
        if (field)
          next[field] =
            issue.message === "required" || !draft[field].trim()
              ? "required"
              : field === "packagingSizeValue"
                ? "sizeFormat"
                : "format";
      }
      setErrors(next);
      setFailure("invalid");
      return;
    }
    if (validateCoverageReview(parsed.data, profileCode).length) {
      setFailure("invalid");
      return;
    }
    busy.current = true;
    setPending(true);
    setFailure(null);
    setSavedNotice(false);
    const release = beginMutation();
    try {
      const value = await client.putProductProfile(product.id, parsed.data);
      if (!alive.current) return;
      setSaved(value);
      setDraft(draftOf(value));
      setErrors({});
      setSavedNotice(true);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof UsClientError && error.code === "conflict") setConflict(true);
      else if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      else if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      else setFailure("failed");
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }

  function textField(field: Field, maximum = 200) {
    return (
      <Input
        key={field}
        label={t(`productProfile.${field}`)}
        value={draft?.[field] ?? ""}
        required={field === "productName"}
        maxLength={maximum}
        disabled={
          pending || !canWrite || (coverageFields.some((item) => item === field) && !canManageQa)
        }
        onChange={(event) => change(field, event.target.value)}
        {...(errors[field] ? { error: t(`productProfile.${errors[field]}`) } : {})}
        {...(field === "packagingSizeValue"
          ? { inputMode: "decimal" as const, hint: t("productProfile.sizeHint") }
          : {})}
      />
    );
  }
  function unitField(field: "packagingSizeUom" | "defaultQuantityUom") {
    return (
      <Select
        native
        label={t(`productProfile.${field}`)}
        value={draft?.[field] ?? ""}
        disabled={pending || !canWrite}
        onValueChange={(value) => change(field, value)}
        options={[
          { value: "", label: t("productProfile.empty") },
          ...UOM_CODES_V1.map((value) => ({ value, label: t(`productProfile.units.${value}`) })),
        ]}
        {...(errors[field] ? { error: t(`productProfile.${errors[field]}`) } : {})}
      />
    );
  }
  const assessment = saved ? assessCoverageReview(saved, profileCode).state : null;

  return (
    <div className="us-product-profile" aria-busy={pending}>
      <Button
        variant="secondary"
        className="us-product-profile-back"
        disabled={pending}
        onClick={back}
      >
        ← {t("productProfile.back")}
      </Button>
      <header className="us-md-page-header">
        <div>
          <p className="us-product-profile-eyebrow">{t("productProfile.open")}</p>
          <h1 ref={heading} tabIndex={-1}>
            {product.name}
          </h1>
          <p>{t("productProfile.intro")}</p>
        </div>
      </header>
      {pending ? <p role="status">{t("productProfile.loading")}</p> : null}
      {failure || conflict ? (
        <p ref={alert} role="alert" tabIndex={-1} className="us-md-notice us-md-notice--alert">
          {t(`productProfile.${conflict ? "conflict" : failure}`)}
        </p>
      ) : null}
      {failure === "loadError" || conflict ? (
        <Button disabled={pending} onClick={reload}>
          {t("productProfile.latest")}
        </Button>
      ) : null}
      {qaChanged ? (
        <Button disabled={pending} onClick={discardCoverage}>
          {t("productProfile.discardCoverage")}
        </Button>
      ) : null}
      {savedNotice ? (
        <p ref={status} role="status" tabIndex={-1} className="us-md-notice">
          {t("productProfile.saved")}
        </p>
      ) : null}
      {saved && draft ? (
        <form noValidate className="us-md-form" onSubmit={(event) => void submit(event)}>
          <div className="us-product-profile-meta">
            <StatusChip
              status="neutral"
              label={t(saved.revision ? "productProfile.revision" : "productProfile.unsaved", {
                revision: saved.revision,
              })}
            />
            {dirty ? <StatusChip status="warn" label={t("productProfile.draft")} /> : null}
            <span className="us-catalog-identifier">
              {t("catalog.gtinColumn")}: {product.gtin14 ?? t("catalog.noGtin")}
            </span>
          </div>
          {!canWrite ? <p className="us-md-readiness">{t("productProfile.readOnly")}</p> : null}
          <section className="us-md-form-section" aria-labelledby="us-profile-description">
            <h2 id="us-profile-description">{t("productProfile.description")}</h2>
            {textField("productName")}
            <div className="us-md-form-grid us-md-form-grid--three">
              {textField("brandName")}
              {textField("commodity")}
              {textField("variety")}
            </div>
          </section>
          <section className="us-md-form-section" aria-labelledby="us-profile-packaging">
            <h2 id="us-profile-packaging">{t("productProfile.packaging")}</h2>
            <div className="us-md-form-grid">
              {textField("packagingSizeValue", 13)}
              {unitField("packagingSizeUom")}
              {textField("packagingStyle")}
              {unitField("defaultQuantityUom")}
            </div>
          </section>
          <section className="us-md-form-section" aria-labelledby="us-profile-coverage">
            <h2 id="us-profile-coverage">{t("productProfile.review")}</h2>
            {generic ? (
              <p className="us-md-notice">{t("productProfile.generic")}</p>
            ) : (
              <>
                <div className="us-md-readiness">
                  <strong>{t(`productProfile.statuses.${saved.coverageStatus}`)}</strong>
                  <p>
                    {t(
                      assessment === "reviewed"
                        ? "productProfile.reviewed"
                        : "productProfile.blocked",
                    )}
                  </p>
                </div>
                <p className="us-product-profile-hint">{t("productProfile.qaOnly")}</p>
                {qaChanged ? (
                  <p role="alert" className="us-md-field-error">
                    {t("productProfile.qaChanged")}
                  </p>
                ) : null}
                <Select
                  native
                  label={t("productProfile.coverageStatus")}
                  value={draft.coverageStatus}
                  disabled={pending || !canWrite || !canManageQa}
                  onValueChange={(value) => change("coverageStatus", value)}
                  options={COVERAGE_STATUSES.map((value) => ({
                    value,
                    label: t(`productProfile.statuses.${value}`),
                  }))}
                />
                <div>
                  <Textarea
                    label={t("productProfile.coverageRationale")}
                    rows={3}
                    maxLength={2000}
                    value={draft.coverageRationale}
                    disabled={pending || !canWrite || !canManageQa}
                    aria-invalid={errors.coverageRationale ? true : undefined}
                    aria-describedby={
                      errors.coverageRationale ? "us-profile-rationale-error" : undefined
                    }
                    onChange={(event) => change("coverageRationale", event.target.value)}
                  />
                  {errors.coverageRationale ? (
                    <p id="us-profile-rationale-error" className="us-md-field-error">
                      {t(`productProfile.${errors.coverageRationale}`)}
                    </p>
                  ) : null}
                </div>
                {textField("ftlCategory")}
                <div className="us-md-form-grid">
                  {textField("ftlSourceUrl", 2048)}
                  {textField("ftlSourceVersion", 128)}
                </div>
                <p className="us-product-profile-hint">{t("productProfile.sourceHint")}</p>
                {saved.reviewedBy && saved.reviewedAt ? (
                  <dl className="us-md-detail-list">
                    <dt>{t("productProfile.reviewedBy")}</dt>
                    <dd className="us-catalog-identifier">{saved.reviewedBy}</dd>
                    <dt>{t("productProfile.reviewedAt")}</dt>
                    <dd>
                      <time dateTime={saved.reviewedAt}>
                        {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone,
                        }).format(new Date(saved.reviewedAt))}{" "}
                        · {timeZone}
                      </time>
                    </dd>
                  </dl>
                ) : (
                  <p className="us-product-profile-hint">{t("productProfile.noReview")}</p>
                )}
              </>
            )}
          </section>
          <div className="us-md-notice">
            <strong>{t("productProfile.history")}</strong>
            <p>{t("productProfile.historyHint")}</p>
          </div>
          <footer className="us-product-profile-footer">
            <Button variant="secondary" disabled={pending} onClick={back}>
              {t("md.close")}
            </Button>
            {canWrite ? (
              <Button
                type="submit"
                loading={pending}
                disabled={pending || conflict || qaChanged || (!dirty && saved.revision > 0)}
              >
                {t("productProfile.save")}
              </Button>
            ) : null}
          </footer>
        </form>
      ) : null}
    </div>
  );
}
