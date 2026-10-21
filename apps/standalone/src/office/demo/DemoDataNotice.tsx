import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { DeleteDemoDataDialog } from "./DeleteDemoDataDialog.js";

/**
 * «Установлены демо-данные» on «Обзор» (spec 2026-10-21): what the wizard installed, that it stays
 * out of the documents for ГИС МТ and the reports, and, for an administrator, «Удалить
 * демо-данные». Nothing is shown when there is no demo data or it could not be read.
 */
export function DemoDataNotice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const admin = useCan("manageDemoData");
  const demo = useOfficeQuery(officeKeys.demoData, (api, token) => api.getDemoData(token));
  const [asking, setAsking] = useState(false);
  const [removed, setRemoved] = useState(false);

  if (removed) {
    return (
      <Alert tone="ok" role="status">
        {t("office.demo.removed")}
      </Alert>
    );
  }
  if (!demo.isSuccess || !demo.data.present) return null;
  const deleted = () => {
    setAsking(false);
    setRemoved(true);
    // The product, its shifts and their boxes leave every list.
    void client.invalidateQueries({ queryKey: ["office"] });
  };
  return (
    <>
      <Alert
        tone="info"
        aria-label={t("office.demo.title")}
        title={t("office.demo.title")}
        action={
          admin ? (
            <Button variant="secondary" onClick={() => setAsking(true)}>
              {t("office.demo.delete.open")}
            </Button>
          ) : undefined
        }
      >
        {t("office.demo.body")}
      </Alert>
      {asking && (
        <DeleteDemoDataDialog
          summary={demo.data}
          onClose={() => setAsking(false)}
          onDeleted={deleted}
        />
      )}
    </>
  );
}
