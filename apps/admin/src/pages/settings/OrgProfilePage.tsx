import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { hasValidCheckDigit } from "@markiro/domain";
import { Alert, Button, Card, Checkbox, Input, PageHeader, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useOrgProfile,
  useOrgProfileSscc,
  useUpdateOrgProfile,
  useUpdateOrgProfileSscc,
  useUploadOrganizationLogo,
  useDeleteOrganizationLogo,
  type PutOrgProfileInput,
} from "./api.js";

/**
 * Boxes take extension digit 0; 1 is reserved for pallets (06d) -- see
 * `apps/api/src/modules/sscc/sscc.service.ts`'s `BOX_EXTENSION_DIGIT`. This
 * page only ever edits the box counter, so the digit is fixed here rather
 * than exposed as an editable field: `GET /org/profile/sscc` always reads
 * extension digit 0, so a form that let the digit drift would silently stop
 * reflecting whatever it just saved.
 */
const BOX_EXTENSION_DIGIT = 0;

/** A GS1 GLN is always exactly 13 digits; the issuer prefix is its first 9 -- mirrors the server's `deriveIssuerPrefix`. */
const GLN_PATTERN = /^\d{13}$/;

function derivePrefix(gln: string | null | undefined): string | null {
  if (!gln || !GLN_PATTERN.test(gln)) return null;
  return gln.slice(0, 9);
}

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/org-profile/dto.ts): gln optional-but-13-digits with
 * a valid GS1 check digit, gs1Prefixes entries 4-12 digits each -- same
 * convention as `pages/counterparties/CounterpartyForm.tsx`.
 */
const profileFormSchema = z.object({
  gln: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^\d{13}$/.test(v), "pages.settings.profile.errors.glnFormat")
    .refine((v) => !v || hasValidCheckDigit(v), "pages.settings.profile.errors.glnCheckDigit"),
  inn: z.string().trim().optional(),
  gs1Prefixes: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || v.split(",").every((entry) => /^\d{4,12}$/.test(entry.trim())),
      "pages.settings.profile.errors.gs1PrefixesFormat",
    ),
});
type ProfileFormValues = z.infer<typeof profileFormSchema>;

const EMPTY_PROFILE_VALUES: ProfileFormValues = { gln: "", inn: "", gs1Prefixes: "" };

/**
 * Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `ssccCounterSchema`
 * (`nextSerial`: 0..9_999_999 -- a 9-digit prefix leaves a 7-digit serial).
 * Kept as a string in form state (like `ProductForm.tsx`'s capacity fields)
 * so an empty/in-progress value doesn't fight the numeric input.
 */
const ssccFormSchema = z.object({
  nextSerial: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v), "pages.settings.sscc.errors.nextSerialInvalid")
    .refine((v) => Number(v) <= 9_999_999, "pages.settings.sscc.errors.nextSerialInvalid"),
});
type SsccFormValues = z.infer<typeof ssccFormSchema>;

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

function toProfileInput(values: ProfileFormValues): PutOrgProfileInput {
  const gln = values.gln?.trim();
  const inn = values.inn?.trim();
  return {
    gln: gln ? gln : null,
    inn: inn ? inn : null,
    gs1Prefixes: values.gs1Prefixes
      ? values.gs1Prefixes
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [],
  };
}

/**
 * The tenant's own organisation profile (GLN, tax id, GS1 prefixes) plus its
 * box SSCC counter (06c Task 5) -- what a plant migrating off another system
 * sets so it continues issuing SSCCs under the same GLN-derived prefix
 * instead of re-handing-out serials that system already used.
 */
export function OrgProfilePage() {
  const { t } = useTranslation();
  const profileQuery = useOrgProfile();
  const updateProfile = useUpdateOrgProfile();

  const {
    register: registerProfile,
    handleSubmit: handleProfileSubmit,
    reset: resetProfile,
    formState: { errors: profileErrors },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: EMPTY_PROFILE_VALUES,
  });

  useEffect(() => {
    if (profileQuery.data) {
      resetProfile({
        gln: profileQuery.data.gln ?? "",
        inn: profileQuery.data.inn ?? "",
        gs1Prefixes: profileQuery.data.gs1Prefixes.join(", "),
      });
    }
  }, [profileQuery.data, resetProfile]);

  const submitProfile = handleProfileSubmit(async (values) => {
    try {
      await updateProfile.mutateAsync(toProfileInput(values));
      toast("ok", t("pages.settings.profile.toasts.updateSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.settings.profile.toasts.updateError"),
      );
    }
  });

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.settings.title")} />

      {profileQuery.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : profileQuery.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : (
        <>
          <Card title={t("pages.settings.profile.cardTitle")}>
            <form
              onSubmit={(event) => void submitProfile(event)}
              noValidate
              style={{ display: "flex", flexDirection: "column", gap: 16 }}
            >
              <Input
                label={t("pages.settings.profile.glnLabel")}
                mono
                {...errorProp(translateFieldError(t, profileErrors.gln?.message))}
                {...registerProfile("gln")}
              />
              <Input
                label={t("pages.settings.profile.innLabel")}
                mono
                {...errorProp(translateFieldError(t, profileErrors.inn?.message))}
                {...registerProfile("inn")}
              />
              <Input
                label={t("pages.settings.profile.prefixesLabel")}
                hint={t("pages.settings.profile.prefixesHint")}
                {...errorProp(translateFieldError(t, profileErrors.gs1Prefixes?.message))}
                {...registerProfile("gs1Prefixes")}
              />
              <div>
                <Button type="submit" loading={updateProfile.isPending}>
                  {t("pages.settings.profile.save")}
                </Button>
              </div>
            </form>
          </Card>

          <PickupPolicyCard enabled={profileQuery.data.pickupLimitsEnabled} />
          <OrganizationLogoCard logoUrl={profileQuery.data.logoUrl} />

          <OrgProfileSsccCard derivedPrefix={derivePrefix(profileQuery.data.gln)} />
        </>
      )}
    </div>
  );
}

function PickupPolicyCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const update = useUpdateOrgProfile();
  const [checked, setChecked] = useState(enabled);
  useEffect(() => setChecked(enabled), [enabled]);

  const save = async () => {
    try {
      await update.mutateAsync({ pickupLimitsEnabled: checked });
      toast("ok", t("pages.settings.pickupPolicy.toasts.success"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.settings.pickupPolicy.toasts.error"),
      );
    }
  };

  return (
    <Card title={t("pages.settings.pickupPolicy.cardTitle")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Checkbox
          label={t("pages.settings.pickupPolicy.enabledLabel")}
          hint={t("pages.settings.pickupPolicy.enabledHint")}
          checked={checked}
          disabled={update.isPending}
          onCheckedChange={setChecked}
        />
        <div>
          <Button type="button" loading={update.isPending} onClick={() => void save()}>
            {t("pages.settings.pickupPolicy.save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

const ALLOWED_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function adminLogoUrl(relativeUrl: string | null): string | null {
  return relativeUrl?.startsWith("/org/profile/logo/") ? `/api${relativeUrl}` : null;
}

function OrganizationLogoCard({ logoUrl }: { logoUrl: string | null }) {
  const { t } = useTranslation();
  const upload = useUploadOrganizationLogo();
  const remove = useDeleteOrganizationLogo();
  const [error, setError] = useState<string | null>(null);
  const previewUrl = adminLogoUrl(logoUrl);

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED_LOGO_TYPES.has(file.type)) {
      setError(t("pages.settings.logo.invalidType"));
      return;
    }
    try {
      setError(null);
      await upload.mutateAsync(file);
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.settings.logo.uploadError"),
      );
    }
  };

  const deleteLogo = async () => {
    try {
      setError(null);
      await remove.mutateAsync();
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : t("pages.settings.logo.removeError"),
      );
    }
  };

  return (
    <Card title={t("pages.settings.logo.cardTitle")}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={t("pages.settings.logo.previewAlt")}
            style={{
              width: 240,
              height: 96,
              objectFit: "contain",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
            }}
          />
        ) : (
          <div
            aria-label={t("pages.settings.logo.fallbackLabel")}
            style={{
              width: 240,
              height: 96,
              display: "grid",
              placeItems: "center",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              background: "var(--surface-panel)",
              font: "var(--text-h3)",
            }}
          >
            Markiro
          </div>
        )}
        <Input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          label={t("pages.settings.logo.uploadLabel")}
          disabled={upload.isPending || remove.isPending}
          onChange={(event) => void uploadFile(event.target.files?.[0])}
        />
        {previewUrl ? (
          <Button
            type="button"
            variant="secondary"
            loading={remove.isPending}
            onClick={() => void deleteLogo()}
          >
            {t("pages.settings.logo.removeAction")}
          </Button>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
    </Card>
  );
}

/**
 * Separate from the profile form above (its own query, its own save button):
 * the counter is a distinct resource (`GET/PUT /org/profile/sscc`) with its
 * own pending/error states, and saving it must not require re-validating the
 * GLN/prefixes fields above.
 *
 * `derivedPrefix` gates the query itself: `orgProfiles.gln` is nullable, so a
 * first-run tenant has no GLN and thus no derivable prefix, and the server
 * refuses `GET /org/profile/sscc` in that state with a 400 ("organisation
 * profile has no GLN"). Firing the query anyway would surface that expected
 * 400 as the generic `common.loadError` alert -- indistinguishable from a
 * real failure (an expired session, a network fault) sitting right under a
 * profile form that just loaded fine. Instead, while there's no prefix, the
 * query never fires and the form below renders directly in its
 * prefix-unavailable state (read-only hint, disabled save) rather than
 * routing through the loading/error branches at all.
 */
function OrgProfileSsccCard({ derivedPrefix }: { derivedPrefix: string | null }) {
  const { t } = useTranslation();
  const ssccQuery = useOrgProfileSscc({ enabled: derivedPrefix !== null });
  const updateSscc = useUpdateOrgProfileSscc();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SsccFormValues>({
    resolver: zodResolver(ssccFormSchema),
    defaultValues: { nextSerial: "0" },
  });

  useEffect(() => {
    if (ssccQuery.data) {
      reset({ nextSerial: String(ssccQuery.data.nextSerial) });
    }
  }, [ssccQuery.data, reset]);

  const submit = handleSubmit(async (values) => {
    try {
      await updateSscc.mutateAsync({
        extensionDigit: BOX_EXTENSION_DIGIT,
        nextSerial: Number(values.nextSerial),
      });
      toast("ok", t("pages.settings.sscc.toasts.updateSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.settings.sscc.toasts.updateError"),
      );
    }
  });

  // Once there's no prefix, the query above is disabled and never
  // transitions out of TanStack Query's "pending" status on its own -- so
  // these only reflect the query's real loading/error states while a prefix
  // exists to fetch a counter for. With no prefix, neither is true and the
  // form below renders straight into its prefix-unavailable state.
  const isLoading = derivedPrefix !== null && ssccQuery.isPending;
  const isError = derivedPrefix !== null && ssccQuery.isError;

  return (
    <Card title={t("pages.settings.sscc.cardTitle")}>
      <p style={{ font: "var(--text-body)", color: "var(--fg-2)", margin: "0 0 16px" }}>
        {t("pages.settings.sscc.description")}
      </p>

      {isLoading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <Input
            label={t("pages.settings.sscc.prefixLabel")}
            mono
            readOnly
            disabled
            value={derivedPrefix ?? t("pages.settings.sscc.prefixUnavailable")}
          />
          <Input
            label={t("pages.settings.sscc.nextSerialLabel")}
            mono
            inputMode="numeric"
            {...errorProp(translateFieldError(t, errors.nextSerial?.message))}
            {...register("nextSerial")}
          />
          <div>
            <Button type="submit" loading={updateSscc.isPending} disabled={!derivedPrefix}>
              {t("pages.settings.sscc.save")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
