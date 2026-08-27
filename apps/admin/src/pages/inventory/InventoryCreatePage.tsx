import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { AdminPage, PageHeader } from "@markiro/ui";

import { useCreateInventory } from "./api.js";
import { InventoryParametersForm } from "./InventoryParametersForm.js";
import { PreparationSteps } from "./PreparationSteps.js";
import "./inventory.css";

export function InventoryCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateInventory();

  return (
    <AdminPage className="mk-inventory-page">
      <PageHeader title={t("pages.inventory.create.title")} />
      <PreparationSteps current={1} />
      <InventoryParametersForm
        submitLabel={t("pages.inventory.create.next")}
        cancelLabel={t("common.cancel")}
        pending={create.isPending}
        requestError={create.isError ? create.error.message : null}
        onCancel={() => void navigate("/inventory")}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (inventory) => void navigate(`/inventory/${inventory.id}`),
          })
        }
      />
    </AdminPage>
  );
}
