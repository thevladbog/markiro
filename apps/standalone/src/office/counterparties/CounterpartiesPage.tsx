import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, Table, type TableColumn } from "@markiro/ui";

import type { CounterpartyRecord } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName, ArchiveStatus, useStoreRecord } from "../records.js";
import { CounterpartyDialog } from "./CounterpartyDialog.js";

type CounterpartiesDialog = { kind: "create" } | { kind: "edit"; counterparty: CounterpartyRecord };

/**
 * Counterparties (spec §4.3, §4.8): customers of contract manufacturing.
 * Administrators add, change and archive them; technologists read the list.
 */
export function CounterpartiesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const counterparties = useOfficeQuery(officeKeys.counterparties, (api, token) =>
    api.listCounterparties(token),
  );
  const store = useStoreRecord<CounterpartyRecord>(officeKeys.counterparties);
  const [dialog, setDialog] = useState<CounterpartiesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: CounterpartiesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const none = t("office.common.none");

  const columns: TableColumn<CounterpartyRecord>[] = [
    {
      key: "name",
      title: t("office.counterparties.table.name"),
      render: (counterparty) => counterparty.name,
    },
    {
      key: "inn",
      title: t("office.counterparties.table.inn"),
      mono: true,
      render: (counterparty) => counterparty.inn ?? none,
    },
    {
      key: "gln",
      title: t("office.counterparties.table.gln"),
      mono: true,
      render: (counterparty) => counterparty.gln,
    },
    {
      key: "gs1Prefixes",
      title: t("office.counterparties.table.gs1Prefixes"),
      mono: true,
      render: (counterparty) =>
        counterparty.gs1Prefixes.length > 0 ? counterparty.gs1Prefixes.join(", ") : none,
    },
    {
      key: "status",
      title: t("office.counterparties.table.status"),
      render: (counterparty) => <ArchiveStatus archived={counterparty.archived} />,
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.counterparties.table.actions"),
      render: (counterparty) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.counterparties.editNamed", { name: counterparty.name })}
          onClick={() => open({ kind: "edit", counterparty })}
        >
          {t("office.counterparties.edit")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (counterparties.isPending) return <PageLoading />;
    if (counterparties.isError) {
      return (
        <LoadError error={counterparties.error} onRetry={() => void counterparties.refetch()} />
      );
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={activeFirstByName(counterparties.data)}
          getRowKey={(counterparty) => counterparty.id}
          empty={t("office.counterparties.empty")}
          scrollLabel={t("office.counterparties.title")}
        />
        {!canEdit && <p className="office-note">{t("office.common.readOnly")}</p>}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.counterparties.title")}
        actions={
          canEdit ? (
            <Button onClick={() => open({ kind: "create" })}>
              {t("office.counterparties.add")}
            </Button>
          ) : null
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {canEdit && dialog !== null && (
        <CounterpartyDialog
          counterparty={dialog.kind === "edit" ? dialog.counterparty : null}
          onClose={() => setDialog(null)}
          onSaved={(counterparty) => {
            store(counterparty);
            setDialog(null);
            setNotice(
              dialog.kind === "create"
                ? t("office.counterparties.created", { name: counterparty.name })
                : t("office.common.saved"),
            );
          }}
          onReload={() => {
            setDialog(null);
            void counterparties.refetch();
          }}
        />
      )}
    </>
  );
}
