import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Alert, Button, Input, SectionHeader } from "@markiro/ui";
import { platformCommercialContracts, type BillingActCreateDto } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { createBillingAct, issueBillingAct } from "./api.js";

type Progress = "idle" | "creating" | "uploading" | "issued";

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
  const attemptRef = useRef<IssueAttempt | null>(null);
  const [tenantId, setTenantId] = useState(search.get("tenantId") ?? "");
  const [requestId, setRequestId] = useState(search.get("requestId") ?? "");
  const [invoiceId, setInvoiceId] = useState(search.get("invoiceId") ?? "");
  const [orderedServiceId, setOrderedServiceId] = useState(search.get("orderedServiceId") ?? "");
  const issue = useMutation({
    mutationFn: async (attempt: IssueAttempt) => {
      let actId = attempt.actId;
      if (!actId) {
        setProgress("creating");
        const created = await createBillingAct(attempt.create);
        actId = created.id;
        attempt.actId = created.id;
      }
      setProgress("uploading");
      return issueBillingAct(actId, attempt.issueKey, attempt.file);
    },
    onSuccess: async (act) => {
      if (act.status !== "issued" || act.issuedAt === null || act.document?.state !== "ready") {
        setProgress("idle");
        return;
      }
      const issuedRequestId = attemptRef.current?.create.requestId;
      attemptRef.current = null;
      setProgress("issued");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["platform", "billing", "acts"] }),
        issuedRequestId
          ? client.invalidateQueries({
              queryKey: ["platform", "billing", "requests", issuedRequestId],
            })
          : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      setProgress("idle");
      if (!retryable(error)) attemptRef.current = null;
    },
  });
  const resetAttempt = () => {
    attemptRef.current = null;
    issue.reset();
    setValidationError(null);
  };
  const chooseFile = (next: File | undefined) => {
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
    issue.mutate(attempt);
  };
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
          onChange={(event) => {
            setNumber(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.periodStart")}
          type="date"
          value={periodStart}
          onChange={(event) => {
            setPeriodStart(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.periodEnd")}
          type="date"
          value={periodEnd}
          onChange={(event) => {
            setPeriodEnd(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.tenant")}
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.request")}
          value={requestId}
          onChange={(event) => {
            setRequestId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.invoice")}
          value={invoiceId}
          onChange={(event) => {
            setInvoiceId(event.target.value);
            resetAttempt();
          }}
        />
        <Input
          label={t("billingActs.fields.service")}
          value={orderedServiceId}
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
        {progress === "issued" ? <Alert tone="ok">{t("billingActs.progress.issued")}</Alert> : null}
        <Button
          type="submit"
          disabled={
            issue.isPending || progress === "issued" || (issue.isError && !retryable(issue.error))
          }
          loading={issue.isPending}
        >
          {issue.isError && retryable(issue.error)
            ? t("billingActs.retry")
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
