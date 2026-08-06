import { useTranslation } from "react-i18next";

import { Button, Modal } from "@markiro/ui";

import type { CreateKioskInput, KioskDto, UpdateKioskInput } from "./api.js";
import { KioskProductsSection } from "./KioskProductsSection.js";
import {
  KIOSK_PROFILE_FORM_ID,
  KioskProfileForm,
  type KioskFormValues,
} from "./KioskProfileForm.js";

export type { KioskFormValues } from "./KioskProfileForm.js";

export interface KioskFormProps {
  open: boolean;
  mode: "create" | "edit";
  initialValues?: KioskFormValues;
  kiosk?: KioskDto;
  submitting?: boolean;
  onSubmit: (input: CreateKioskInput | UpdateKioskInput) => void | Promise<void>;
  onClose: () => void;
}

/**
 * The edit-only legacy modal. Create now uses KioskProfileForm inside its
 * route-backed panel; retaining this wrapper keeps edit and allowlist behavior
 * unchanged until their panel migration.
 */
export function KioskForm({
  open,
  mode,
  initialValues,
  kiosk,
  submitting = false,
  onSubmit,
  onClose,
}: KioskFormProps) {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t("common.close")}
      title={
        mode === "create" ? t("pages.kiosks.form.createTitle") : t("pages.kiosks.form.editTitle")
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.kiosks.cancel")}
          </Button>
          <Button type="submit" form={KIOSK_PROFILE_FORM_ID} loading={submitting}>
            {mode === "create"
              ? t("pages.kiosks.form.submitCreate")
              : t("pages.kiosks.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <KioskProfileForm
        {...(initialValues ? { initialValues } : {})}
        submitting={submitting}
        submissionError={null}
        onSubmit={onSubmit}
        onDirtyChange={() => undefined}
      />
      {mode === "edit" && kiosk ? (
        <KioskProductsSection
          kiosk={kiosk}
          onDirtyChange={() => undefined}
          onBusyChange={() => undefined}
          onErrorChange={() => undefined}
        />
      ) : null}
    </Modal>
  );
}
