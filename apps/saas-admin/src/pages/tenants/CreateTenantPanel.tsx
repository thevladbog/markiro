import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, type FieldError } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";

import { Alert, Button, Card, ConfirmDialog, Input, PageHeader } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { createTenant, createTenantInputSchema, type CreateTenantInput } from "./api.js";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

function validationMessage(error: FieldError, t: (key: string) => string): string {
  return t(
    `tenants.createForm.validation.${typeof error.message === "string" ? error.message : "required"}`,
  );
}

export function CreateTenantPanel() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null);
  const form = useForm<CreateTenantInput>({
    resolver: zodResolver(createTenantInputSchema),
    defaultValues: { tenantName: "", tenantSlug: "", email: "" },
  });
  const create = useMutation({ mutationFn: createTenant });
  const guard = useUnsavedChanges(form.formState.isDirty, create.isPending);
  const canCreate =
    principal.role !== "accountant" && principal.capabilities.includes("tenants.write");

  if (!canCreate) return <Navigate to="/tenants" replace />;

  const submit = form.handleSubmit(async (values) => {
    setSubmitErrorCode(null);
    try {
      const created = await create.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] });
      guard.allowNextNavigation();
      void navigate(`/tenants/${created.tenantId}`, {
        replace: true,
        state: { tenantCreated: true },
      });
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : null;
      setSubmitErrorCode(code ?? "create_failed");
    }
  });

  return (
    <section className="tenant-create-page">
      <PageHeader title={t("tenants.createForm.title")} />
      <div className="catalog-coordinate" aria-hidden="true">
        TENANTS / PROVISION
      </div>
      <Card className="tenant-create-card">
        <div className="tenant-create-intro">
          <h2>{t("tenants.createForm.ownerTitle")}</h2>
          <p>{t("tenants.createForm.demoNotice")}</p>
        </div>
        {submitErrorCode ? (
          <Alert tone="error">{t(`tenants.errors.${submitErrorCode}`)}</Alert>
        ) : null}
        <form className="tenant-create-form" noValidate onSubmit={(event) => void submit(event)}>
          <Input
            label={t("tenants.createForm.name")}
            required
            {...(form.formState.errors.tenantName
              ? { error: validationMessage(form.formState.errors.tenantName, t) }
              : {})}
            {...form.register("tenantName")}
          />
          <Input
            label={t("tenants.createForm.slug")}
            required
            mono
            autoCapitalize="none"
            autoCorrect="off"
            {...(form.formState.errors.tenantSlug
              ? { error: validationMessage(form.formState.errors.tenantSlug, t) }
              : {})}
            {...form.register("tenantSlug")}
          />
          <Input
            label={t("tenants.createForm.email")}
            required
            type="email"
            autoComplete="email"
            {...(form.formState.errors.email
              ? { error: validationMessage(form.formState.errors.email, t) }
              : {})}
            {...form.register("email")}
          />
          <div className="tenant-form-actions">
            <Button type="submit" loading={create.isPending}>
              {t("tenants.createForm.submit")}
            </Button>
            <Button variant="secondary" onClick={() => void navigate("/tenants")}>
              {t("tenants.cancel")}
            </Button>
          </div>
        </form>
      </Card>
      <ConfirmDialog
        open={guard.confirmOpen}
        title={t("tenants.unsaved.title")}
        description={t("tenants.unsaved.body")}
        confirmLabel={t("tenants.unsaved.discard")}
        cancelLabel={t("tenants.unsaved.continue")}
        tone="destructive"
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </section>
  );
}
