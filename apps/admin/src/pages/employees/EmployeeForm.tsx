import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input, Modal, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import {
  useIssueBadge,
  useRevokeBadge,
  type BadgeDto,
  type CreateEmployeeInput,
  type EmployeeDto,
} from "./api.js";
import {
  useGrantStationAccess,
  useOperators,
  useRevokeStationAccess,
  useUpdateStationAccess,
} from "./station-access-api.js";

/**
 * Client-side mirror of the server's zod schema
 * (apps/api/src/modules/employees/dto.ts): fullName 1..200, role optional
 * (<=120). Error messages are i18n keys (resolved through `t()` at render
 * time) -- same convention as `pages/counterparties/CounterpartyForm.tsx`.
 */
const employeeFormSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "pages.employees.form.errors.fullNameRequired")
    .max(200, "pages.employees.form.errors.fullNameTooLong"),
  role: z.string().trim().max(120, "pages.employees.form.errors.roleTooLong").optional(),
});

export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

export interface EmployeeFormProps {
  open: boolean;
  mode: "create" | "edit";
  /** The employee being edited -- only set in edit mode. Drives the badges sub-panel (id + badges list) below the fields. */
  employee?: EmployeeDto;
  initialValues?: EmployeeFormValues;
  submitting?: boolean;
  onSubmit: (input: CreateEmployeeInput) => void | Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: EmployeeFormValues = { fullName: "", role: "" };

const FORM_ID = "employee-form";

/** Converts a possibly-undefined zod issue message (an i18n key) into translated text. */
function translateFieldError(t: TFunction, message: string | undefined): string | undefined {
  return message ? t(message) : undefined;
}

/**
 * Formats an ISO timestamp for the badge "issued" caption using the active
 * i18next language -- mirrors `pages/pickup/index.tsx`'s `formatCreatedAt`.
 */
function formatIssuedAt(iso: string, language: string): string {
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

export function EmployeeForm({
  open,
  mode,
  employee,
  initialValues,
  submitting = false,
  onSubmit,
  onClose,
}: EmployeeFormProps) {
  const { t, i18n } = useTranslation();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeFormSchema),
    defaultValues: initialValues ?? EMPTY_VALUES,
  });

  // Re-seed the form whenever the modal opens -- see
  // CounterpartyForm.tsx's identical effect for the rationale (`reset` is a
  // stable react-hook-form reference, intentionally left out of the deps).
  useEffect(() => {
    if (open) {
      reset(initialValues ?? EMPTY_VALUES);
    }
  }, [open, initialValues, reset]);

  const submit = handleSubmit(async (values) => {
    await onSubmit(toCreateInput(values));
  });

  // --- Badge issue/revoke sub-panel (edit mode only) ---
  const issueBadgeMutation = useIssueBadge();
  const [badgeCode, setBadgeCode] = useState("");
  const [badgeLabel, setBadgeLabel] = useState("");
  const revokeBadgeMutation = useRevokeBadge();
  const [revokingBadgeId, setRevokingBadgeId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBadgeCode("");
      setBadgeLabel("");
    }
  }, [open, employee?.id]);

  const handleIssueBadge = async () => {
    if (!employee) return;
    const code = badgeCode.trim();
    if (!code) return;
    try {
      await issueBadgeMutation.mutateAsync({
        id: employee.id,
        input: { badgeCode: code, label: badgeLabel.trim() ? badgeLabel.trim() : null },
      });
      toast("ok", t("pages.employees.toasts.issueBadgeSuccess"));
      setBadgeCode("");
      setBadgeLabel("");
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.employees.toasts.issueBadgeError"),
      );
    }
  };

  const handleRevokeBadge = async (badge: BadgeDto) => {
    if (!employee) return;
    setRevokingBadgeId(badge.id);
    try {
      await revokeBadgeMutation.mutateAsync({ id: employee.id, badgeId: badge.id });
      toast("ok", t("pages.employees.toasts.revokeBadgeSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.employees.toasts.revokeBadgeError"),
      );
    } finally {
      setRevokingBadgeId(null);
    }
  };

  // --- Station access sub-panel (edit mode only) ---
  const operatorsQuery = useOperators();
  const grantAccessMutation = useGrantStationAccess();
  const updateAccessMutation = useUpdateStationAccess();
  const revokeAccessMutation = useRevokeStationAccess();
  const [accessLogin, setAccessLogin] = useState("");
  const [accessPin, setAccessPin] = useState("");

  const access = employee
    ? operatorsQuery.data?.find((op) => op.employeeId === employee.id)
    : undefined;

  useEffect(() => {
    if (open) {
      setAccessLogin("");
      setAccessPin("");
    }
  }, [open, employee?.id]);

  /** Runs a station-access mutation with the file's shared toast/error idiom. */
  const runAccess = async (action: () => Promise<unknown>) => {
    try {
      await action();
      toast("ok", t("pages.employees.toasts.stationAccessSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.employees.toasts.stationAccessError"),
      );
    }
  };

  /** No existing access yet: PUT grants it, establishing both the login and the PIN. */
  const handleGrantAccess = async () => {
    if (!employee) return;
    const login = accessLogin.trim();
    const pin = accessPin.trim();
    if (!login || !pin) return;
    await runAccess(() =>
      grantAccessMutation.mutateAsync({ employeeId: employee.id, input: { login, pin } }),
    );
    setAccessPin("");
  };

  /**
   * Access already exists: PATCH only `pin`, leaving `login` and `active`
   * untouched. Using the PUT/grant path here would silently re-activate a
   * deliberately disabled operator and, on a mistyped personnel number,
   * rename the login instead of resetting the PIN (see F1 review finding).
   */
  const handleResetPin = async () => {
    if (!employee) return;
    const pin = accessPin.trim();
    if (!pin) return;
    await runAccess(() =>
      updateAccessMutation.mutateAsync({ employeeId: employee.id, input: { pin } }),
    );
    setAccessPin("");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create"
          ? t("pages.employees.form.createTitle")
          : t("pages.employees.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.employees.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.employees.form.submitCreate")
              : t("pages.employees.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <form
          id={FORM_ID}
          onSubmit={(event) => void submit(event)}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <Input
            label={t("pages.employees.form.fullNameLabel")}
            {...errorProp(translateFieldError(t, errors.fullName?.message))}
            {...register("fullName")}
          />
          <Input
            label={t("pages.employees.form.roleLabel")}
            {...errorProp(translateFieldError(t, errors.role?.message))}
            {...register("role")}
          />
        </form>

        {mode === "edit" && employee && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              borderTop: "1px solid var(--line)",
              paddingTop: 16,
            }}
          >
            <span style={{ font: "600 13px/1 var(--font-ui)", color: "var(--fg-1)" }}>
              {t("pages.employees.badges.title")}
            </span>

            {employee.badges.length === 0 ? (
              <p style={{ font: "var(--text-caption)", color: "var(--fg-3)", margin: 0 }}>
                {t("pages.employees.badges.emptyHint")}
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {employee.badges.map((badge) => (
                  <li
                    key={badge.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
                        {badge.label ?? badge.badgeCode}
                      </span>
                      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                        {t("pages.employees.badges.issuedAt", {
                          date: formatIssuedAt(badge.issuedAt, i18n.language),
                        })}
                      </span>
                    </div>
                    {badge.revokedAt === null ? (
                      <Button
                        type="button"
                        size="compact"
                        variant="secondary"
                        loading={revokingBadgeId === badge.id}
                        onClick={() => void handleRevokeBadge(badge)}
                      >
                        {t("pages.employees.badges.revokeAction")}
                      </Button>
                    ) : (
                      <StatusChip
                        status="neutral"
                        label={t("pages.employees.badges.revokedBadge")}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <Input
                  label={t("pages.employees.badges.codeLabel")}
                  mono
                  value={badgeCode}
                  onChange={(event) => setBadgeCode(event.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Input
                  label={t("pages.employees.badges.labelLabel")}
                  value={badgeLabel}
                  onChange={(event) => setBadgeLabel(event.target.value)}
                />
              </div>
              <Button
                type="button"
                size="compact"
                disabled={badgeCode.trim().length === 0}
                loading={issueBadgeMutation.isPending}
                onClick={() => void handleIssueBadge()}
              >
                {t("pages.employees.badges.issueAction")}
              </Button>
            </div>
          </div>
        )}

        {mode === "edit" && employee && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              borderTop: "1px solid var(--line)",
              paddingTop: 16,
            }}
          >
            <span style={{ font: "600 13px/1 var(--font-ui)", color: "var(--fg-1)" }}>
              {t("pages.employees.stationAccess.title")}
            </span>

            {access ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
                  {t("pages.employees.stationAccess.current", { login: access.login })}
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <StatusChip
                    status={access.active ? "ok" : "neutral"}
                    label={
                      access.active
                        ? t("pages.employees.stationAccess.activeBadge")
                        : t("pages.employees.stationAccess.disabledBadge")
                    }
                  />
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    loading={updateAccessMutation.isPending}
                    onClick={() =>
                      void runAccess(() =>
                        updateAccessMutation.mutateAsync({
                          employeeId: employee.id,
                          input: { active: !access.active },
                        }),
                      )
                    }
                  >
                    {access.active
                      ? t("pages.employees.stationAccess.disableAction")
                      : t("pages.employees.stationAccess.enableAction")}
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="destructive"
                    loading={revokeAccessMutation.isPending}
                    onClick={() =>
                      void runAccess(() => revokeAccessMutation.mutateAsync(employee.id))
                    }
                  >
                    {t("pages.employees.stationAccess.revokeAction")}
                  </Button>
                </div>
              </div>
            ) : operatorsQuery.isError ? (
              // A failed GET /operators must not be mistaken for "no access
              // granted" -- that empty-state hint invites a duplicate grant
              // which then 409s (see F4 review finding).
              <p style={{ font: "var(--text-caption)", color: "var(--err-fg)", margin: 0 }}>
                {t("pages.employees.stationAccess.loadError")}
              </p>
            ) : operatorsQuery.isSuccess ? (
              <p style={{ font: "var(--text-caption)", color: "var(--fg-3)", margin: 0 }}>
                {t("pages.employees.stationAccess.emptyHint")}
              </p>
            ) : (
              // Still loading: same rationale as the error branch above --
              // an undefined `access` here must not be read as "no access"
              // (see C4 review finding).
              <p style={{ font: "var(--text-caption)", color: "var(--fg-3)", margin: 0 }}>
                {t("pages.employees.stationAccess.loading")}
              </p>
            )}

            {access ? (
              // Access already exists: reset only the PIN (PATCH). The personnel
              // number is already shown above (`stationAccess.current`), so it is
              // dropped from this row rather than re-collected -- a retyped value
              // here would tempt a PUT/replace that could rename the login on a
              // typo (see F1 review finding).
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <Input
                    label={t("pages.employees.stationAccess.pinLabel")}
                    mono
                    inputMode="numeric"
                    type="password"
                    value={accessPin}
                    onChange={(event) => setAccessPin(event.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  size="compact"
                  disabled={accessPin.trim().length === 0}
                  loading={updateAccessMutation.isPending}
                  onClick={() => void handleResetPin()}
                >
                  {t("pages.employees.stationAccess.resetAction")}
                </Button>
              </div>
            ) : operatorsQuery.isSuccess ? (
              // Only render the grant controls once the lookup has actually
              // confirmed there is no access -- while pending or after an
              // error, `access` is `undefined` for the same reason a real
              // "no access" employee is, and a duplicate grant here would
              // 409 against a credential the UI never saw (see C4 review
              // finding).
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <Input
                    label={t("pages.employees.stationAccess.loginLabel")}
                    mono
                    inputMode="numeric"
                    value={accessLogin}
                    onChange={(event) => setAccessLogin(event.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Input
                    label={t("pages.employees.stationAccess.pinLabel")}
                    mono
                    inputMode="numeric"
                    type="password"
                    value={accessPin}
                    onChange={(event) => setAccessPin(event.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  size="compact"
                  disabled={accessLogin.trim().length === 0 || accessPin.trim().length === 0}
                  loading={grantAccessMutation.isPending}
                  onClick={() => void handleGrantAccess()}
                >
                  {t("pages.employees.stationAccess.grantAction")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Normalizes raw form values into the API's create/update payload shape. */
function toCreateInput(values: EmployeeFormValues): CreateEmployeeInput {
  const role = values.role?.trim();
  return {
    fullName: values.fullName.trim(),
    role: role ? role : null,
  };
}
