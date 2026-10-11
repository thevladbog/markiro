import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useForm, type FieldError } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import { createTenant, createTenantInputSchema, type CreateTenantInput } from "../tenants/api.js";
import { tenantErrorMessageKey } from "../tenants/errorMessages.js";

function validationMessage(error: FieldError, t: (key: string) => string): string {
  return t(
    `tenants.createForm.validation.${typeof error.message === "string" ? error.message : "required"}`,
  );
}

/**
 * Creates a tenant without a cabinet from the offer editor. It is an inline
 * form rather than a modal: no modal primitive is used by this app for small
 * forms, and the trigger stays mounted so focus can return to it on close.
 */
export function CreateOfflineTenantDialog({
  onCreated,
}: {
  onCreated: (tenantId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const titleId = useId();
  const triggerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const form = useForm<CreateTenantInput>({
    resolver: zodResolver(createTenantInputSchema),
    defaultValues: { tenantName: "", tenantSlug: "", cabinetAccess: "none" },
  });
  const create = useMutation({ mutationFn: createTenant });

  const focusTrigger = () => {
    // Runs after the form unmounts so focus is not lost to <body>.
    queueMicrotask(() => triggerRef.current?.querySelector("button")?.focus());
  };
  const close = () => {
    form.reset();
    setErrorKey(null);
    setOpen(false);
    focusTrigger();
  };

  const submit = form.handleSubmit(async (values) => {
    setErrorKey(null);
    try {
      const created = await create.mutateAsync(values);
      await queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] });
      form.reset();
      setOpen(false);
      onCreated(created.tenantId);
      focusTrigger();
    } catch (error) {
      setErrorKey(tenantErrorMessageKey("create", error));
    }
  });

  return (
    <section className="offline-tenant-create" aria-labelledby={titleId}>
      <div ref={triggerRef}>
        <Button
          variant="secondary"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {t("offers.createOfflineTenant.button")}
        </Button>
      </div>
      {open ? (
        <form className="tenant-create-form" noValidate onSubmit={(event) => void submit(event)}>
          <h2 id={titleId}>{t("offers.createOfflineTenant.title")}</h2>
          <p className="tenant-muted">{t("offers.createOfflineTenant.hint")}</p>
          {errorKey ? <Alert tone="error">{t(errorKey)}</Alert> : null}
          <Input
            label={t("tenants.createForm.name")}
            required
            autoFocus
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
          <div className="tenant-form-actions">
            <Button type="submit" loading={create.isPending}>
              {t("offers.createOfflineTenant.submit")}
            </Button>
            <Button variant="secondary" disabled={create.isPending} onClick={close}>
              {t("tenants.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
