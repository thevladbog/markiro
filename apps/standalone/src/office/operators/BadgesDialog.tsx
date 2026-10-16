import { useTranslation } from "react-i18next";

import { Alert, Button, cn, Modal, StatusChip } from "@markiro/ui";

import type { BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { badgeLabel } from "./operator-records.js";

const DATE = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" });

export interface BadgesDialogProps {
  operator: OfficeOperator;
  /** A badge just added or revoked, said above the list. */
  notice: string | null;
  onAdd: () => void;
  onRevoke: (badge: BadgeInfo) => void;
  onClose: () => void;
}

/**
 * An operator's badges, revoked ones too: they stay listed, dimmed and
 * marked «Отозван», as the record of what was issued. A badge in use can be
 * revoked; a new card is always a new badge.
 */
export function BadgesDialog({ operator, notice, onAdd, onRevoke, onClose }: BadgesDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open
      title={t("office.operators.badges.title", { name: operator.name })}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button onClick={onAdd}>{t("office.operators.badges.add")}</Button>
        </>
      }
    >
      <div className="standalone-form">
        {notice && <Alert tone="ok">{notice}</Alert>}
        {operator.badges.length === 0 ? (
          <p>{t("office.operators.badges.empty")}</p>
        ) : (
          <ul className="badge-list">
            {operator.badges.map((badge) => {
              const label = badgeLabel(badge, t);
              const date = DATE.format(new Date(badge.createdAt));
              const revoked = badge.revokedAt !== null;
              return (
                <li
                  key={badge.id}
                  className={cn("badge-list__item", revoked && "badge-list__item--revoked")}
                >
                  <OfficeIcon name="badge" size={24} />
                  <span className="badge-list__name">
                    <span className="badge-list__label">{label}</span>
                    <span className="badge-list__date">
                      <span>{t("office.operators.badges.addedAt", { date })}</span>
                      <span aria-hidden="true"> · </span>
                      {/* The code is never shown, only its hash is kept. */}
                      <span>{t("office.operators.badges.codeHidden")}</span>
                    </span>
                  </span>
                  <StatusChip
                    phase={revoked ? "retired" : "active"}
                    label={t(
                      revoked
                        ? "office.operators.badges.status.revoked"
                        : "office.operators.badges.status.active",
                    )}
                  />
                  {!revoked && (
                    <Button
                      variant="secondary"
                      icon={<OfficeIcon name="stop" size={20} />}
                      aria-label={t("office.operators.badges.revokeNamed", { label, date })}
                      onClick={() => onRevoke(badge)}
                    >
                      {t("office.operators.badges.revoke")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
