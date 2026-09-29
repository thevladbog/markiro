import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import {
  grantCabinetAccess,
  grantCabinetAccessInputSchema,
  type GrantCabinetAccessInput,
} from "./api.js";
import { tenantErrorMessageKey } from "./errorMessages.js";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

export function GrantCabinetAccessPanel({
  tenantId,
  canGrant,
  onGranted,
}: {
  tenantId: string;
  canGrant: boolean;
  onGranted?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  // The trigger is unmounted while the form is open, so focus returns to it
  // after the re-render that mounts it again, not to <body>.
  const returnFocus = useRef(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const form = useForm<GrantCabinetAccessInput>({
    resolver: zodResolver(grantCabinetAccessInputSchema),
    defaultValues: { email: "" },
  });
  const grant = useMutation({
    mutationFn: (input: GrantCabinetAccessInput) => grantCabinetAccess(tenantId, input),
  });
  useUnsavedChanges(form.formState.isDirty, grant.isPending);
  const { setFocus } = form;

  useEffect(() => {
    if (open) {
      setFocus("email");
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.querySelector("button")?.focus();
    }
  }, [open, setFocus]);

  const close = () => {
    form.reset();
    setErrorKey(null);
    returnFocus.current = true;
    setOpen(false);
  };

  const submit = form.handleSubmit(async (values) => {
    setErrorKey(null);
    try {
      await grant.mutateAsync(values);
      form.reset();
      returnFocus.current = true;
      setOpen(false);
      onGranted?.();
      // The prefix covers this tenant's detail and every list page.
      await queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] });
    } catch (error) {
      setErrorKey(tenantErrorMessageKey("grant", error));
    }
  });

  return (
    <section className="owner-activation cabinet-grant" aria-labelledby={titleId}>
      <h3 id={titleId}>{t("tenants.detail.offline.title")}</h3>
      <span>{t("tenants.detail.offline.body")}</span>
      {canGrant && !open ? (
        <div ref={triggerRef}>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t("tenants.detail.offline.grant")}
          </Button>
        </div>
      ) : null}
      {canGrant && open ? (
        <form className="tenant-create-form" noValidate onSubmit={(event) => void submit(event)}>
          {errorKey ? <Alert tone="error">{t(errorKey)}</Alert> : null}
          <Input
            label={t("tenants.detail.offline.email")}
            required
            type="email"
            autoComplete="email"
            {...(form.formState.errors.email
              ? { error: t("tenants.createForm.validation.email") }
              : {})}
            {...form.register("email")}
          />
          <div className="tenant-form-actions">
            <Button type="submit" loading={grant.isPending}>
              {t("tenants.detail.offline.submit")}
            </Button>
            <Button variant="secondary" disabled={grant.isPending} onClick={close}>
              {t("tenants.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
