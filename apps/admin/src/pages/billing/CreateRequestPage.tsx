import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Alert, Button, Card, Input, Select, Textarea } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  createBillingRequest,
  invalidateTenantBillingRequests,
  tenantBillingKeys,
  uploadBillingRequestAttachment,
} from "./api.js";
import {
  BILLING_REQUEST_TYPES,
  contextFromSearch,
  desiredAtIso,
  hasBillingRequestFormErrors,
  isBillingRequestType,
  type BillingRequestFormErrors,
  type BillingRequestFormValues,
  validateBillingRequestForm,
} from "./requestForm.js";

export interface AttachmentUploadResult {
  file: File;
  state: "ready" | "failed";
}

interface CreateAttempt {
  payload: Parameters<typeof createBillingRequest>[0];
  key: string;
}

function retryable(cause: unknown): boolean {
  return !(cause instanceof ApiRequestError) || cause.status >= 500;
}

export function CreateRequestPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const initialContext = contextFromSearch(params);
  const requestedType = params.get("type");
  const initialType = isBillingRequestType(requestedType) ? requestedType : "renewal";
  const [values, setValues] = useState<BillingRequestFormValues>({
    type: initialType,
    description: "",
    desiredAt: "",
    contextType: initialContext?.type ?? "",
    contextId: initialContext?.id ?? "",
    files: [],
  });
  const [errors, setErrors] = useState<BillingRequestFormErrors>({ files: [] });
  const [actionError, setActionError] = useState<"retryable" | "terminal" | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const attempt = useRef<CreateAttempt | null>(null);
  const lock = useRef(false);

  const update = (next: BillingRequestFormValues) => {
    setValues(next);
    setErrors({ files: [] });
    setActionError(null);
    attempt.current = null;
  };

  const submit = (reuse = false) =>
    void (async () => {
      if (lock.current) return;
      const validation = validateBillingRequestForm(values);
      setErrors(validation);
      if (hasBillingRequestFormErrors(validation)) return;
      const normalizedDesiredAt = desiredAtIso(values.desiredAt);
      const next: CreateAttempt | null = reuse
        ? attempt.current
        : {
            payload: {
              type: values.type,
              description: values.description.trim(),
              ...(normalizedDesiredAt ? { desiredAt: normalizedDesiredAt } : {}),
              ...(values.contextType && values.contextId
                ? { context: { type: values.contextType, id: values.contextId } }
                : {}),
            },
            key: crypto.randomUUID(),
          };
      if (!next) return;
      attempt.current = next;
      lock.current = true;
      setBusy(true);
      setActionError(null);
      try {
        let created;
        try {
          created = await createBillingRequest(next.payload, next.key);
        } catch (cause) {
          if (retryable(cause)) setActionError("retryable");
          else {
            attempt.current = null;
            setActionError("terminal");
          }
          return;
        }
        attempt.current = null;
        const attachmentUploads: AttachmentUploadResult[] = [];
        for (const file of values.files) {
          setUploading(file.name);
          try {
            await uploadBillingRequestAttachment(created.id, file);
            attachmentUploads.push({ file, state: "ready" });
          } catch {
            attachmentUploads.push({ file, state: "failed" });
          }
        }
        setUploading(null);
        try {
          await invalidateTenantBillingRequests(client, created.id);
        } catch {
          // The request already exists. Normal query refresh remains available on detail.
        }
        client.setQueryData(tenantBillingKeys.request(created.id), created);
        void navigate(`/billing/requests/${created.id}`, { state: { attachmentUploads } });
      } finally {
        lock.current = false;
        setBusy(false);
      }
    })();

  const descriptionError = errors.description
    ? t(`pages.billing.requests.create.errors.description.${errors.description}`)
    : undefined;
  return (
    <section className="mk-billing-request-create" aria-labelledby="billing-request-create-heading">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-request-create-heading">
            {t("pages.billing.requests.create.heading")}
          </h2>
          <p>{t("pages.billing.requests.create.description")}</p>
        </div>
        <Link className="mk-billing-inline-link" to="/billing/requests">
          {t("pages.billing.requests.create.back")}
        </Link>
      </div>
      {actionError ? (
        <Alert tone="error">
          {t(`pages.billing.requests.create.errors.${actionError}`)}{" "}
          {actionError === "retryable" && attempt.current ? (
            <Button variant="secondary" disabled={busy} onClick={() => submit(true)}>
              {t("pages.billing.requests.create.retry")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      <Card title={t("pages.billing.requests.create.formTitle")} titleAs="h3">
        <form
          className="mk-billing-request-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Select
            native
            label={t("pages.billing.requests.create.type")}
            value={values.type}
            disabled={busy}
            onValueChange={(type) => update({ ...values, type })}
            options={BILLING_REQUEST_TYPES.map((type) => ({
              value: type,
              label: t(`pages.billing.requests.types.${type}`),
            }))}
          />
          <Textarea
            label={t("pages.billing.requests.create.descriptionLabel")}
            value={values.description}
            maxLength={4001}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={descriptionError ? "billing-request-description-error" : undefined}
            disabled={busy}
            onChange={(event) => update({ ...values, description: event.target.value })}
          />
          {descriptionError ? (
            <p className="mk-billing-field-error" id="billing-request-description-error">
              {descriptionError}
            </p>
          ) : null}
          <Input
            label={t("pages.billing.requests.create.desiredAt")}
            type="date"
            value={values.desiredAt}
            {...(errors.desiredAt
              ? { error: t("pages.billing.requests.create.errors.desiredAt") }
              : {})}
            disabled={busy}
            onChange={(event) => update({ ...values, desiredAt: event.target.value })}
          />
          {values.contextType && values.contextId ? (
            <p className="mk-billing-request-context">
              {t("pages.billing.requests.create.context", {
                type: t(`pages.billing.requests.contextTypes.${values.contextType}`),
                id:
                  values.contextType === "limit"
                    ? t(`pages.billing.limits.${values.contextId}`)
                    : values.contextId,
              })}
            </p>
          ) : null}
          <Input
            label={t("pages.billing.requests.create.files")}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png"
            disabled={busy}
            onChange={(event) => update({ ...values, files: Array.from(event.target.files ?? []) })}
          />
          {errors.files.length > 0 ? (
            <ul className="mk-billing-form-errors" role="alert">
              {errors.files.map((error, index) => (
                <li key={`${error.fileName}-${error.reason}-${index}`}>
                  {t(`pages.billing.requests.create.errors.file.${error.reason}`, {
                    name: error.fileName,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          {uploading ? (
            <p aria-live="polite">
              {t("pages.billing.requests.create.uploading", { name: uploading })}
            </p>
          ) : null}
          <Button type="submit" loading={busy} disabled={busy}>
            {t("pages.billing.createRequest")}
          </Button>
        </form>
      </Card>
    </section>
  );
}
