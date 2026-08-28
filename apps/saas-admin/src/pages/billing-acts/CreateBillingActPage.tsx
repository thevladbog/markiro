import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Alert, Button, Input, SectionHeader } from "@markiro/ui";
import { platformCommercialContracts, type BillingActCreateDto } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { createBillingAct, getBillingAct, issueBillingAct } from "./api.js";

type Progress = "idle" | "creating" | "uploading" | "draft" | "issued";

interface IssueAttempt {
  create: BillingActCreateDto;
  issueKey: string;
  file: File;
  actId: string | null;
}

export function CreateBillingActPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.write")) {
    return (
      <section className="catalog-page">
        <h1>{t("billingActs.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingActs.forbiddenBody")}</Alert>
      </section>
    );
  }
  return <BillingActForm />;
}

function BillingActForm() {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const client = useQueryClient();
  const [number, setNumber] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>("idle");
  const [forbidden, setForbidden] = useState(false);
  const attemptRef = useRef<IssueAttempt | null>(null);
  const [attempt, setAttempt] = useState<IssueAttempt | null>(null);
  const [tenantId, setTenantId] = useState(search.get("tenantId") ?? "");
  const [requestId, setRequestId] = useState(search.get("requestId") ?? "");
  const [invoiceId, setInvoiceId] = useState(search.get("invoiceId") ?? "");
  const [orderedServiceId, setOrderedServiceId] = useState(search.get("orderedServiceId") ?? "");
  const invalidateActFamilies = async (current: IssueAttempt) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "billing", "acts"] }),
      client.invalidateQueries({ queryKey: ["platform", "billing", "requests"] }),
      current.actId
        ? client.invalidateQueries({
            queryKey: ["platform", "billing", "acts", current.actId],
          })
        : Promise.resolve(),
      current.actId
        ? client.invalidateQueries({
            queryKey: ["platform", "billing", "acts", current.actId, "document"],
          })
        : Promise.resolve(),
      current.create.requestId
        ? client.invalidateQueries({
            queryKey: ["platform", "billing", "requests", current.create.requestId],
          })
        : Promise.resolve(),
    ]);
  };
  const latchForbidden = async (current: IssueAttempt) => {
    setForbidden(true);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "me"] }),
      invalidateActFamilies(current),
    ]);
  };
  const issue = useMutation({
    mutationFn: async (current: IssueAttempt) => {
      let issuedAttempt = current;
      let actId = current.actId;
      if (!actId) {
        setProgress("creating");
        const created = await createBillingAct(current.create);
        actId = created.id;
        issuedAttempt = { ...current, actId: created.id };
        attemptRef.current = issuedAttempt;
        setAttempt(issuedAttempt);
        setProgress("draft");
        await invalidateActFamilies(issuedAttempt);
      }
      setProgress("uploading");
      return issueBillingAct(actId, issuedAttempt.issueKey, issuedAttempt.file);
    },
    onSuccess: async (act) => {
      if (act.status !== "issued" || act.issuedAt === null || act.document?.state !== "ready") {
        setProgress("draft");
        const retained = attemptRef.current;
        if (retained) await invalidateActFamilies(retained);
        return;
      }
      const issuedAttempt = attemptRef.current;
      attemptRef.current = null;
      setAttempt(null);
      setProgress("issued");
      if (issuedAttempt) await invalidateActFamilies(issuedAttempt);
    },
    onError: async (error) => {
      const retained = attemptRef.current;
      if (retained && isForbidden(error)) {
        setAttempt(retained);
        if (retained.actId) setProgress("draft");
        await latchForbidden(retained);
        return;
      }
      if (retained?.actId) {
        setAttempt(retained);
        setProgress("draft");
        await invalidateActFamilies(retained);
        return;
      }
      setProgress("idle");
      if (retained) await invalidateActFamilies(retained);
      if (!retryable(error)) {
        attemptRef.current = null;
        setAttempt(null);
      }
    },
  });
  const reconcile = useMutation({
    mutationFn: (actId: string) => getBillingAct(actId),
    onSuccess: async (act) => {
      const retained = attemptRef.current;
      if (!retained) return;
      if (act.status === "issued" && act.issuedAt !== null && act.document?.state === "ready") {
        attemptRef.current = null;
        setAttempt(null);
        issue.reset();
        setProgress("issued");
      } else {
        setProgress("draft");
      }
      await invalidateActFamilies(retained);
    },
    onError: async (error) => {
      const retained = attemptRef.current;
      if (!retained) return;
      if (isForbidden(error)) {
        setAttempt(retained);
        await latchForbidden(retained);
        return;
      }
      await invalidateActFamilies(retained);
    },
  });
  const resetAttempt = () => {
    if (attemptRef.current) return;
    attemptRef.current = null;
    setAttempt(null);
    issue.reset();
    setValidationError(null);
  };
  const chooseFile = (next: File | undefined) => {
    if (attemptRef.current) return;
    resetAttempt();
    setValidationError(null);
    setFile(null);
    if (!next) return;
    if (next.type !== "application/pdf") {
      setValidationError(t("billingActs.errors.pdfOnly"));
      return;
    }
    if (next.size === 0 || next.size > 5 * 1024 * 1024) {
      setValidationError(t("billingActs.errors.pdfSize"));
      return;
    }
    setFile(next);
  };
  const submit = () => {
    if (issue.isPending) return;
    if (!file) {
      setValidationError(t("billingActs.errors.pdfRequired"));
      return;
    }
    const existing = attemptRef.current;
    if (existing) {
      issue.mutate(existing);
      return;
    }
    const parsedRequestId = optionalLink(requestId);
    const parsedInvoiceId = optionalLink(invoiceId);
    const parsedOrderedServiceId = optionalLink(orderedServiceId);
    const parsed = platformCommercialContracts.billingActs.create.body.safeParse({
      tenantId,
      ...(parsedRequestId ? { requestId: parsedRequestId } : {}),
      ...(parsedInvoiceId ? { invoiceId: parsedInvoiceId } : {}),
      ...(parsedOrderedServiceId ? { orderedServiceId: parsedOrderedServiceId } : {}),
      number,
      periodStart,
      periodEnd,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!parsed.success) {
      setValidationError(t("billingActs.errors.form"));
      return;
    }
    const attempt: IssueAttempt = {
      create: parsed.data,
      issueKey: crypto.randomUUID(),
      file,
      actId: null,
    };
    attemptRef.current = attempt;
    setAttempt(attempt);
    issue.mutate(attempt);
  };
  const frozen = attempt !== null;
  if (forbidden) {
    return (
      <section className="catalog-page">
        <h1>{t("billingActs.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingActs.forbiddenBody")}</Alert>
        {attempt?.actId ? (
          <p>
            {t("billingActs.forbiddenDraft")} <code>{attempt.actId}</code>
          </p>
        ) : null}
      </section>
    );
  }
  return (
    <section className="catalog-page billing-act-page">
      <SectionHeader
        eyebrow="COMMERCE / ACTS / ISSUE"
        title={t("billingActs.title")}
        description={t("billingActs.description")}
        actionsLabel={t("billingActs.actions")}
        actions={
          <Link
            to={optionalUuid(requestId) ? `/billing-requests/${requestId}` : "/billing-requests"}
          >
            {t("billingActs.back")}
          </Link>
        }
      />
      <form
        className="billing-act-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          label={t("billingActs.fields.number")}
          value={number}
          disabled={frozen}
          onChange={(event) => {
            setNumber(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.periodStart")}
          type="date"
          value={periodStart}
          disabled={frozen}
          onChange={(event) => {
            setPeriodStart(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.periodEnd")}
          type="date"
          value={periodEnd}
          disabled={frozen}
          onChange={(event) => {
            setPeriodEnd(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.tenant")}
          value={tenantId}
          disabled={frozen}
          onChange={(event) => {
            setTenantId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.request")}
          value={requestId}
          disabled={frozen}
          onChange={(event) => {
            setRequestId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.invoice")}
          value={invoiceId}
          disabled={frozen}
          onChange={(event) => {
            setInvoiceId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.service")}
          value={orderedServiceId}
          disabled={frozen}
          onChange={(event) => {
            setOrderedServiceId(event.target.value);
            resetAttempt();
          }}
        />
        <div className="billing-act-file">
          <label htmlFor="billing-act-pdf">{t("billingActs.fields.pdf")}</label>
          <input
            id="billing-act-pdf"
            type="file"
            accept="application/pdf,.pdf"
            disabled={frozen}
            aria-describedby="billing-act-pdf-hint"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <small id="billing-act-pdf-hint">{t("billingActs.fields.pdfHint")}</small>
        </div>
        {validationError ? <Alert tone="error">{validationError}</Alert> : null}
        {issue.error ? (
          <Alert tone="error">
            {retryable(issue.error)
              ? t("billingActs.errors.retryable")
              : t("billingActs.errors.authoritative")}
          </Alert>
        ) : null}
        {progress === "creating" ? <p role="status">{t("billingActs.progress.creating")}</p> : null}
        {progress === "uploading" ? (
          <p role="status">{t("billingActs.progress.uploading")}</p>
        ) : null}
        {attempt?.actId ? (
          <>
            <Alert tone="info">{t("billingActs.progress.draftSaved")}</Alert>
            <p>
              {t("billingActs.fields.actId")} <code>{attempt.actId}</code>
            </p>
          </>
        ) : null}
        {progress === "issued" ? <Alert tone="ok">{t("billingActs.progress.issued")}</Alert> : null}
        {attempt?.actId ? (
          <Button
            type="button"
            variant="secondary"
            disabled={issue.isPending || reconcile.isPending}
            loading={reconcile.isPending}
            onClick={() => {
              if (attempt.actId) reconcile.mutate(attempt.actId);
            }}
          >
            {t("billingActs.reconcile")}
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={issue.isPending || progress === "issued"}
          loading={issue.isPending}
        >
          {issue.isError
            ? attempt?.actId
              ? t("billingActs.resume")
              : t("billingActs.retry")
            : t("billingActs.submit")}
        </Button>
      </form>
    </section>
  );
}

function optionalUuid(value: string | null): string | undefined {
  return platformCommercialContracts.billingActs.detail.params.safeParse(value).data;
}

function optionalLink(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}

function retryable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === null || error.status >= 500);
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403;
}
