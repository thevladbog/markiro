import { useBlocker } from "react-router";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@markiro/ui";
export function SheetNavigationGuard({
  dirty,
  busy,
  allowed,
}: {
  dirty: boolean;
  busy: boolean;
  allowed: RefObject<boolean>;
}) {
  const { t } = useTranslation();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowed.current &&
      (dirty || busy) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  return (
    <Modal
      open={blocker.state === "blocked"}
      title={t("pages.labels.sheet.unsaved")}
      onClose={() => {
        if (blocker.state === "blocked") blocker.reset();
      }}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              if (blocker.state === "blocked") blocker.reset();
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              if (blocker.state === "blocked") {
                allowed.current = true;
                blocker.proceed();
              }
            }}
          >
            {t("pages.labels.sheet.discard")}
          </Button>
        </>
      }
    >
      <p>{t("pages.labels.sheet.unsavedHint")}</p>
    </Modal>
  );
}
