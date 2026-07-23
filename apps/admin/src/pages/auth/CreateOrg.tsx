import { zodResolver } from "@hookform/resolvers/zod";
import { useState, type ChangeEvent } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import { Alert, Button, Input } from "@markiro/ui";

import { useAuthClient } from "../../auth/client.js";
import { errorProp } from "../../lib/form-error.js";
import { AuthLayout } from "./AuthLayout.js";

// The validation messages below are i18n keys (resolved through `t()` at
// render time, see `slugError` further down), not literal user-facing text.
const createOrgSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1, "auth.createOrg.slugRequired")
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "auth.createOrg.slugInvalid"),
});

type CreateOrgFormValues = z.infer<typeof createOrgSchema>;

/** Derives a URL-safe slug candidate from a free-text organization name. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateOrgPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrgFormValues>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: "", slug: "" },
  });

  const nameField = register("name", {
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (!slugTouched) {
        setValue("slug", slugify(event.target.value), { shouldValidate: true });
      }
    },
  });
  const slugField = register("slug", {
    onChange: () => setSlugTouched(true),
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const { data, error } = await authClient.organization.create(values);
    if (error || !data) {
      setSubmitError(error?.message ?? t("auth.createOrg.genericError"));
      return;
    }
    await authClient.organization.setActive({ organizationId: data.id });
    void navigate("/", { replace: true });
  });

  const slugError = errors.slug?.message ? t(errors.slug.message) : undefined;

  return (
    <AuthLayout title={t("auth.createOrg.title")}>
      <form
        onSubmit={(event) => void onSubmit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <Input
          label={t("auth.createOrg.nameLabel")}
          {...errorProp(errors.name?.message)}
          {...nameField}
        />
        <Input
          label={t("auth.createOrg.slugLabel")}
          mono
          {...errorProp(slugError)}
          {...slugField}
        />
        <Button type="submit" loading={isSubmitting} fullWidth>
          {t("auth.createOrg.submit")}
        </Button>
        <p style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          <Link to="/org/select">{t("auth.createOrg.selectExisting")}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
