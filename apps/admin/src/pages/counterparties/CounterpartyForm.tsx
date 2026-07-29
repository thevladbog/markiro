import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { hasValidCheckDigit } from "@markiro/domain";
import { Alert, Button, Input, Modal, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useCounterpartySscc,
  useUpdateCounterpartySscc,
  type CreateCounterpartyInput,
} from "./api.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/counterparties/dto.ts): name 1..200, GLN exactly 13
 * digits with a valid GS1 check digit, gs1Prefixes entries 4-12 digits each.
 * The error messages below are i18n keys (resolved through `t()` at render
 * time, not literal user-facing text) -- same convention as
 * `pages/auth/CreateOrg.tsx`'s `slugError`.
 *
 * `gs1Prefixes` is edited here as a single comma-separated string field (per
 * the plan) rather than a chip list -- normalized into a `string[]` on
 * submit by `toCreateInput` below.
 */
const counterpartyFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "pages.counterparties.form.errors.nameRequired")
    .max(200, "pages.counterparties.form.errors.nameTooLong"),
  gln: z
    .string()
    .trim()
    .regex(/^\d{13}$/, "pages.counterparties.form.errors.glnFormat")
    .refine((v) => hasValidCheckDigit(v), "pages.counterparties.form.errors.glnCheckDigit"),
  inn: z.string().trim().optional(),
  gs1Prefixes: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || v.split(",").every((entry) => /^\d{4,12}$/.test(entry.trim())),
      "pages.counterparties.form.errors.gs1PrefixesFormat",
    ),
  notes: z.string().trim().optional(),
});

export type CounterpartyFormValues = z.infer<typeof counterpartyFormSchema>;

export interface CounterpartyFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: CounterpartyFormValues;
  /** Only present in edit mode -- the SSCC counter section below needs an existing counterparty to key its GET/PUT on. */
  counterpartyId?: string;
  submitting?: boolean;
  onSubmit: (input: CreateCounterpartyInput) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Boxes take extension digit 0; 1 is reserved for pallets (06d) -- see
 * `apps/api/src/modules/sscc/sscc.service.ts`'s `BOX_EXTENSION_DIGIT`. Same
 * fixed-digit choice as `pages/settings/OrgProfilePage.tsx`'s counter form.
 */
const BOX_EXTENSION_DIGIT = 0;

/** A GS1 GLN is always exactly 13 digits; the issuer prefix is its first 9 -- mirrors the server's `deriveIssuerPrefix`. */
const GLN_PATTERN = /^\d{13}$/;

function derivePrefix(gln: string | undefined): string | null {
  if (!gln || !GLN_PATTERN.test(gln)) return null;
  return gln.slice(0, 9);
}

/**
 * Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `ssccCounterSchema`
 * (`nextSerial`: 0..9_999_999). Kept as a string in form state, same
 * convention as `ProductForm.tsx`'s capacity fields.
 */
const ssccFormSchema = z.object({
  nextSerial: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v), "pages.counterparties.form.sscc.errors.nextSerialInvalid")
    .refine(
      (v) => Number(v) <= 9_999_999,
      "pages.counterparties.form.sscc.errors.nextSerialInvalid",
    ),
});
type SsccFormValues = z.infer<typeof ssccFormSchema>;

const EMPTY_VALUES: CounterpartyFormValues = {
  name: "",
  gln: "",
  inn: "",
  gs1Prefixes: "",
  notes: "",
};

const FORM_ID = "counterparty-form";

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

export function CounterpartyForm({
  open,
  mode,
  initialValues,
  counterpartyId,
  submitting = false,
  onSubmit,
  onClose,
}: CounterpartyFormProps) {
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CounterpartyFormValues>({
    resolver: zodResolver(counterpartyFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  // Re-seed the form whenever the modal opens (covers both the create ->
  // create and edit A -> edit B cases, since defaultValues is only read once
  // by react-hook-form on mount). `reset` is a stable function reference per
  // react-hook-form's own docs, so it's intentionally left out of the deps.
  useEffect(() => {
    if (open) {
      reset(initialValues ?? EMPTY_VALUES);
    }
  }, [open, initialValues, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values));
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create"
          ? t("pages.counterparties.form.createTitle")
          : t("pages.counterparties.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.counterparties.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.counterparties.form.submitCreate")
              : t("pages.counterparties.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(event) => void submit(event)}
        noValidate
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <Input
          label={t("pages.counterparties.form.nameLabel")}
          {...errorProp(translateFieldError(t, errors.name?.message))}
          {...register("name")}
        />
        <Input
          label={t("pages.counterparties.form.glnLabel")}
          mono
          {...errorProp(translateFieldError(t, errors.gln?.message))}
          {...register("gln")}
        />
        <Input
          label={t("pages.counterparties.form.innLabel")}
          mono
          {...errorProp(translateFieldError(t, errors.inn?.message))}
          {...register("inn")}
        />
        <Input
          label={t("pages.counterparties.form.prefixesLabel")}
          hint={t("pages.counterparties.form.prefixesHint")}
          {...errorProp(translateFieldError(t, errors.gs1Prefixes?.message))}
          {...register("gs1Prefixes")}
        />
        <Input
          label={t("pages.counterparties.form.notesLabel")}
          {...errorProp(translateFieldError(t, errors.notes?.message))}
          {...register("notes")}
        />
      </form>

      {/* Sibling to (not nested in) the form above -- its own resource
          (`GET/PUT /counterparties/:id/sscc`) with its own save action, kept
          out of the outer form so saving it never runs the name/gln/notes
          validation above. Only meaningful once the counterparty exists. */}
      {mode === "edit" && counterpartyId && (
        <CounterpartySsccSection counterpartyId={counterpartyId} gln={initialValues?.gln} />
      )}
    </Modal>
  );
}

function CounterpartySsccSection({
  counterpartyId,
  gln,
}: {
  counterpartyId: string;
  gln: string | undefined;
}) {
  const { t } = useTranslation();
  const ssccQuery = useCounterpartySscc(counterpartyId);
  const updateSscc = useUpdateCounterpartySscc();
  const derivedPrefix = derivePrefix(gln);

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
        id: counterpartyId,
        input: { extensionDigit: BOX_EXTENSION_DIGIT, nextSerial: Number(values.nextSerial) },
      });
      toast("ok", t("pages.counterparties.form.sscc.toasts.updateSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.counterparties.form.sscc.toasts.updateError"),
      );
    }
  });

  return (
    <div
      style={{
        marginTop: 20,
        paddingTop: 20,
        borderTop: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div>
        <span style={{ font: "var(--text-h3)", color: "var(--fg-1)" }}>
          {t("pages.counterparties.form.sscc.cardTitle")}
        </span>
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)", margin: "4px 0 0" }}>
          {t("pages.counterparties.form.sscc.description")}
        </p>
      </div>

      {ssccQuery.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : ssccQuery.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Input
            label={t("pages.counterparties.form.sscc.prefixLabel")}
            mono
            readOnly
            disabled
            value={derivedPrefix ?? ""}
          />
          <Input
            label={t("pages.counterparties.form.sscc.nextSerialLabel")}
            mono
            inputMode="numeric"
            {...errorProp(translateFieldError(t, errors.nextSerial?.message))}
            {...register("nextSerial")}
          />
          <div>
            <Button type="button" loading={updateSscc.isPending} onClick={() => void submit()}>
              {t("pages.counterparties.form.sscc.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Normalizes raw form values into the API's create/update payload shape. */
function toCreateInput(values: CounterpartyFormValues): CreateCounterpartyInput {
  const inn = values.inn?.trim();
  const notes = values.notes?.trim();
  return {
    name: values.name.trim(),
    gln: values.gln.trim(),
    inn: inn ? inn : null,
    gs1Prefixes: values.gs1Prefixes
      ? values.gs1Prefixes
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [],
    notes: notes ? notes : null,
  };
}
