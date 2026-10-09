import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionGrid,
  PageHeader,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { SsccCounter, SsccState } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { BlockSizesForm } from "./BlockSizesForm.js";
import { CounterDialog } from "./CounterDialog.js";
import { counterKindKey, isExhausted } from "./counter-kind.js";

/** The current GLN's counters first; the host already orders by prefix and extension. */
function orderedCounters(state: SsccState): SsccCounter[] {
  const current = state.counters.filter((each) => each.issuerPrefix === state.currentIssuerPrefix);
  const others = state.counters.filter((each) => each.issuerPrefix !== state.currentIssuerPrefix);
  return [...current, ...others];
}

function replaceCounter(state: SsccState, updated: SsccCounter): SsccState {
  return {
    ...state,
    counters: state.counters.map((each) =>
      each.issuerPrefix === updated.issuerPrefix && each.extension === updated.extension
        ? updated
        : each,
    ),
  };
}

/** SSCC counters and block sizes (spec §4.3, §5.5): administrators change them, technologists read them. */
export function SsccPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.sscc.title")} />
      <SsccContent />
    </>
  );
}

function SsccContent() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
  const queryClient = useQueryClient();
  const sscc = useOfficeQuery(officeKeys.sscc, (api, token) => api.getSscc(token));
  const [editing, setEditing] = useState<SsccCounter | null>(null);
  const [saved, setSaved] = useState<"counter" | "blocks" | null>(null);

  if (sscc.isPending) return <PageLoading />;
  if (sscc.isError) return <LoadError error={sscc.error} onRetry={() => void sscc.refetch()} />;

  const state = sscc.data;
  const kindOf = (counter: SsccCounter) =>
    t(counterKindKey(counter), { extension: counter.extension });
  const columns: TableColumn<SsccCounter>[] = [
    {
      key: "prefix",
      title: t("office.sscc.table.prefix"),
      mono: true,
      render: (counter) => (
        <>
          {counter.issuerPrefix}
          {counter.issuerPrefix === state.currentIssuerPrefix && (
            <>
              {" "}
              <Badge tone="info">{t("office.sscc.current")}</Badge>
            </>
          )}
        </>
      ),
    },
    { key: "kind", title: t("office.sscc.table.kind"), render: kindOf },
    {
      key: "next",
      title: t("office.sscc.table.next"),
      mono: true,
      align: "right",
      // A counter past its last serial (`sscc_exhausted` once a block is asked for)
      // has no next number to show or to set.
      render: (counter) =>
        isExhausted(counter) ? (
          <StatusChip phase="attention" label={t("office.sscc.exhausted")} />
        ) : (
          String(counter.nextSerial)
        ),
    },
    {
      key: "max",
      title: t("office.sscc.table.max"),
      mono: true,
      align: "right",
      render: (counter) => String(counter.maxSerial),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.sscc.table.actions"),
      render: (counter) =>
        isExhausted(counter) ? null : (
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.sscc.editNamed", {
              kind: kindOf(counter),
              prefix: counter.issuerPrefix,
            })}
            onClick={() => {
              setSaved(null);
              setEditing(counter);
            }}
          >
            {t("office.sscc.edit")}
          </Button>
        ),
    });
  }

  return (
    <>
      <Card title={t("office.sscc.countersTitle")} titleAs="h2">
        {saved === "counter" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.countersIntro")}</p>
        <Table
          columns={columns}
          rows={orderedCounters(state)}
          getRowKey={(counter) => `${counter.issuerPrefix}-${counter.extension}`}
          empty={t("office.sscc.noCounters")}
          scrollLabel={t("office.sscc.countersTitle")}
        />
      </Card>
      <Card title={t("office.sscc.blocksTitle")} titleAs="h2">
        {saved === "blocks" && <Alert tone="ok">{t("office.common.saved")}</Alert>}
        <p className="office-note">{t("office.sscc.blocksIntro")}</p>
        {canEdit ? (
          <BlockSizesForm
            key={state.blockSizesRev}
            state={state}
            onSaved={(next) => {
              queryClient.setQueryData(officeKeys.sscc, next);
              setSaved("blocks");
            }}
            onSubmitStart={() => setSaved(null)}
            onReload={() => void sscc.refetch()}
          />
        ) : (
          <>
            <DefinitionGrid
              items={[
                {
                  id: "box",
                  term: t("office.sscc.boxBlock"),
                  description: String(state.boxBlockSize),
                  mono: true,
                },
                {
                  id: "pallet",
                  term: t("office.sscc.palletBlock"),
                  description: String(state.palletBlockSize),
                  mono: true,
                },
              ]}
            />
            <p className="office-note">{t("office.common.readOnly")}</p>
          </>
        )}
      </Card>
      {canEdit && editing && (
        <CounterDialog
          counter={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            queryClient.setQueryData<SsccState>(officeKeys.sscc, (current) =>
              current ? replaceCounter(current, updated) : current,
            );
            setEditing(null);
            setSaved("counter");
          }}
          onReload={() => {
            setEditing(null);
            void sscc.refetch();
          }}
        />
      )}
    </>
  );
}
