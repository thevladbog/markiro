import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, ConfirmDialog, Input, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { type BadgeDto, type EmployeeDto, useIssueBadge, useRevokeBadge } from "./api.js";

export interface EmployeeBadgesSectionProps {
  employee: EmployeeDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
}

/** Formats the badge issue date for the active admin language. */
function formatIssuedAt(iso: string, language: string): string {
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

function mutationError(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * Self-contained badge issue and revoke controls for an existing employee.
 * The three state reporters let a route panel compose this section with other
 * independent resources without lifting transient badge values into its parent.
 */
export function EmployeeBadgesSection({
  employee,
  onDirtyChange,
  onBusyChange,
  onErrorChange,
}: EmployeeBadgesSectionProps) {
  const { t, i18n } = useTranslation();
  const issueMutation = useIssueBadge();
  const revokeMutation = useRevokeBadge();
  const [badgeCode, setBadgeCode] = useState("");
  const [badgeLabel, setBadgeLabel] = useState("");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BadgeDto | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const dirty = badgeCode.trim().length > 0 || badgeLabel.trim().length > 0;
  const busy = issueMutation.isPending || revokeMutation.isPending;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(
    () => onErrorChange(issueError !== null || revokeError !== null),
    [issueError, revokeError, onErrorChange],
  );

  const issueBadge = async () => {
    const code = badgeCode.trim();
    if (!code) return;

    try {
      await issueMutation.mutateAsync({
        id: employee.id,
        input: { badgeCode: code, label: badgeLabel.trim() ? badgeLabel.trim() : null },
      });
      toast("ok", t("pages.employees.toasts.issueBadgeSuccess"));
      setBadgeCode("");
      setBadgeLabel("");
      setIssueError(null);
    } catch (error) {
      setIssueError(mutationError(error, t("pages.employees.badges.issueError")));
    }
  };

  const openRevokeConfirmation = (badge: BadgeDto) => {
    setRevokeError(null);
    setRevokeTarget(badge);
  };

  const closeRevokeConfirmation = () => {
    if (revokeMutation.isPending) return;
    setRevokeTarget(null);
    setRevokeError(null);
  };

  const revokeBadge = async () => {
    if (!revokeTarget) return;

    try {
      await revokeMutation.mutateAsync({ id: employee.id, badgeId: revokeTarget.id });
      toast("ok", t("pages.employees.toasts.revokeBadgeSuccess"));
      setRevokeTarget(null);
      setRevokeError(null);
    } catch (error) {
      setRevokeError(mutationError(error, t("pages.employees.badges.revokeError")));
    }
  };

  return (
    <>
      <section
        className="mk-employee-badges-section"
        role="region"
        aria-label={t("pages.employees.badges.title")}
      >
        <h3 className="mk-employee-badges-section__title">{t("pages.employees.badges.title")}</h3>

        {issueError ? <Alert tone="error">{issueError}</Alert> : null}

        {employee.badges.length === 0 ? (
          <p className="mk-employee-badges-section__empty">
            {t("pages.employees.badges.emptyHint")}
          </p>
        ) : (
          <ul className="mk-employee-badges-section__list">
            {employee.badges.map((badge) => (
              <li className="mk-employee-badges-section__item" key={badge.id}>
                <div className="mk-employee-badges-section__details">
                  <span className="mk-employee-badges-section__name">
                    {badge.label ?? badge.badgeCode}
                  </span>
                  <span className="mk-employee-badges-section__issued-at">
                    {t("pages.employees.badges.issuedAt", {
                      date: formatIssuedAt(badge.issuedAt, i18n.language),
                    })}
                  </span>
                </div>
                <div className="mk-employee-badges-section__actions">
                  {badge.revokedAt === null ? (
                    <>
                      <StatusChip status="ok" label={t("pages.employees.badges.activeBadge")} />
                      <Button
                        type="button"
                        size="compact"
                        variant="secondary"
                        onClick={() => openRevokeConfirmation(badge)}
                      >
                        {t("pages.employees.badges.revokeAction")}
                      </Button>
                    </>
                  ) : (
                    <StatusChip status="neutral" label={t("pages.employees.badges.revokedBadge")} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mk-employee-badges-section__issue-row">
          <Input
            label={t("pages.employees.badges.codeLabel")}
            mono
            value={badgeCode}
            onChange={(event) => setBadgeCode(event.target.value)}
          />
          <Input
            label={t("pages.employees.badges.labelLabel")}
            value={badgeLabel}
            onChange={(event) => setBadgeLabel(event.target.value)}
          />
          <Button
            type="button"
            size="compact"
            disabled={badgeCode.trim().length === 0}
            loading={issueMutation.isPending}
            onClick={() => void issueBadge()}
          >
            {t("pages.employees.badges.issueAction")}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={t("pages.employees.badges.revokeTitle")}
        description={t("pages.employees.badges.revokeBody")}
        entity={revokeTarget?.label ?? revokeTarget?.badgeCode}
        error={revokeError ?? undefined}
        confirmLabel={t("pages.employees.badges.revokeConfirmAction")}
        cancelLabel={t("pages.employees.cancel")}
        tone="destructive"
        busy={revokeMutation.isPending}
        onConfirm={() => void revokeBadge()}
        onCancel={closeRevokeConfirmation}
      />
    </>
  );
}
