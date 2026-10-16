import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import {
  Alert,
  Button,
  Input,
  PageHeader,
  Select,
  StatusChip,
  type TableColumn,
} from "@markiro/ui";

import type { DisaggregationDocument, DisaggregationStatus } from "../../host/disaggregation.js";
import { isCivilDate } from "../../lib/civil-date.js";
import { useCan } from "../access.js";
import { alertFailure, failureMessage } from "../form-errors.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { listViewState } from "../list/list-state.js";
import { DateRange, ListCard, ListFilters } from "../list/ListCard.js";
import { ListEmpty, ListError, ListNothing, ListSkeleton } from "../list/ListStates.js";
import { PagedTable } from "../paging/PagedTable.js";
import { searchableSelect } from "../select-search.js";
import { documentFilter, type DocumentFilterState } from "./document-list.js";
import { byReasonOrder, DOCUMENT_STATUS_PHASE } from "./disaggregation-text.js";

const STATUS_FILTERS: readonly DocumentFilterState["status"][] = [
  "all",
  "draft",
  "applied",
  "cancelled",
];

/** How long the number is left alone before the host is asked, as the cloud waits. */
const SEARCH_PAUSE_MS = 300;

/** The count of a number as Russian writes it: «1 200». */
const COUNTS = new Intl.NumberFormat("ru");

/**
 * Disaggregation documents (plan ДЗГ-О), in the section «Производство». The
 * host sends at most the 1 000 newest and narrows them by status, reason, the
 * creation period and a piece of the number; the pages are made here. «С» and
 * «По» are the organization's days, turned into the host's instants.
 */
export function DisaggregationPage() {
  const { t } = useTranslation();
  const canWrite = useCan("planShifts");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const failureId = useId();
  const [status, setStatus] = useState<DocumentFilterState["status"]>("all");
  const [reasonId, setReasonId] = useState("");
  const [docNo, setDocNo] = useState("");
  // The number the host was last asked for: it follows the typed one after a pause.
  const [askedNo, setAskedNo] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    // Nothing typed since the host was asked: no timer, and the page the user turned to stays.
    if (docNo === askedNo) return undefined;
    const timer = setTimeout(() => {
      setAskedNo(docNo);
    }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [docNo, askedNo]);

  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const reasons = useOfficeQuery(officeKeys.disaggregationReasons, (api, token) =>
    api.listDisaggregationReasons(token),
  );
  const zone = formTimeZone(org.data);
  const reversed = isCivilDate(from) && isCivilDate(to) && from > to;
  const filter = documentFilter({ status, reasonId, docNo: askedNo, from, to }, zone);
  const documents = useOfficeQuery(
    officeKeys.disaggregationList(filter),
    (api, token) => api.listDisaggregations(token, filter),
    { enabled: !reversed },
  );
  const create = useOfficeMutation((api, token, _: void) =>
    api.createDisaggregation(token, { reasonId: null, comment: null }),
  );

  useEffect(() => {
    if (failure !== null) document.getElementById(failureId)?.focus();
  }, [failure, failureId]);

  const filtersOn =
    status !== "all" || reasonId !== "" || docNo.trim() !== "" || from !== "" || to !== "";
  const resetFilters = () => {
    setStatus("all");
    setReasonId("");
    setDocNo("");
    setAskedNo("");
    setFrom("");
    setTo("");
  };
  const makeDocument = async () => {
    setFailure(null);
    let detail;
    try {
      detail = await create.mutateAsync();
    } catch (error) {
      setFailure(t(failureMessage(alertFailure(error))));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: officeKeys.disaggregation });
    void navigate(`/disaggregation/${detail.document.id}`);
  };

  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: zone,
  });
  const reasonOrder = [...(reasons.data ?? [])].sort(byReasonOrder);
  const statusLabel = (value: DisaggregationStatus) => t(`office.disaggregation.statuses.${value}`);

  const columns: TableColumn<DisaggregationDocument>[] = [
    {
      key: "docNo",
      title: t("office.disaggregation.table.docNo"),
      mono: true,
      render: (document) => (
        <Link
          to={`/disaggregation/${document.id}`}
          aria-label={t("office.disaggregation.openNamed", { docNo: document.docNo })}
        >
          {document.docNo}
        </Link>
      ),
    },
    {
      key: "createdAt",
      title: t("office.disaggregation.table.createdAt"),
      mono: true,
      render: (document) => time.format(new Date(document.createdAt)),
    },
    {
      key: "status",
      title: t("office.disaggregation.table.status"),
      render: (document) => (
        <StatusChip
          phase={DOCUMENT_STATUS_PHASE[document.status]}
          label={statusLabel(document.status)}
        />
      ),
    },
    {
      key: "reason",
      title: t("office.disaggregation.table.reason"),
      wrap: true,
      minWidth: 180,
      render: (document) => document.reasonName ?? t("office.common.none"),
    },
    {
      key: "lineCount",
      title: t("office.disaggregation.table.lineCount"),
      mono: true,
      align: "right",
      render: (document) => COUNTS.format(document.lineCount),
    },
    {
      key: "codeCount",
      title: t("office.disaggregation.table.codeCount"),
      mono: true,
      align: "right",
      render: (document) => COUNTS.format(document.codeCount),
    },
    {
      key: "author",
      title: t("office.disaggregation.table.author"),
      wrap: true,
      minWidth: 150,
      render: (document) => document.createdByName,
    },
  ];

  const view = listViewState({
    pending: documents.isPending && !reversed,
    failed: documents.isError && !reversed,
    // The server filters: an empty answer is «none» or «none with this filter».
    total: filtersOn ? 1 : (documents.data?.length ?? 0),
    found: documents.data?.length ?? 0,
  });
  const state =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError error={documents.error} onRetry={() => void documents.refetch()} />
    ) : view === "empty" ? (
      <ListEmpty icon="split" title={t("office.disaggregation.empty")} />
    ) : view === "nothing" ? (
      <ListNothing title={t("office.disaggregation.nothingFound")} onReset={resetFilters} />
    ) : null;
  const content = () =>
    reversed ? null : (
      <PagedTable
        tableId="disaggregation"
        pagerLabel={t("office.disaggregation.pager")}
        resetKey={JSON.stringify(filter)}
        columns={columns}
        rows={view === "error" ? [] : (documents.data ?? [])}
        getRowKey={(document) => document.id}
        empty={state}
        scrollLabel={t("office.disaggregation.title")}
      />
    );

  return (
    <>
      <PageHeader
        title={t("office.disaggregation.title")}
        description={t("office.disaggregation.subtitle")}
        actions={
          <>
            <Link to="/disaggregation/reasons">{t("office.disaggregation.reasonsLink")}</Link>
            {canWrite && (
              <Button loading={create.isPending} onClick={() => void makeDocument()}>
                {t("office.disaggregation.create")}
              </Button>
            )}
          </>
        }
      />
      {failure !== null && (
        <Alert tone="error" id={failureId} tabIndex={-1}>
          {failure}
        </Alert>
      )}
      <ListCard>
        <ListFilters
          label={t("office.disaggregation.filters.label")}
          resultSummary={
            documents.isSuccess && !reversed
              ? t("office.disaggregation.found", { count: documents.data.length })
              : ""
          }
          onReset={filtersOn ? resetFilters : undefined}
          resetLabel={t("office.disaggregation.filters.reset")}
        >
          <Select
            label={t("office.disaggregation.filters.status")}
            options={STATUS_FILTERS.map((value) => ({
              value,
              label:
                value === "all" ? t("office.disaggregation.filters.statusAll") : statusLabel(value),
            }))}
            value={status}
            onValueChange={(value) => {
              setStatus(value);
            }}
          />
          <Select
            {...searchableSelect(t)}
            label={t("office.disaggregation.filters.reason")}
            options={[
              { value: "", label: t("office.disaggregation.filters.reasonAll") },
              ...reasonOrder.map((reason) => ({
                value: reason.id,
                label: reason.archived
                  ? t("office.common.archivedName", { name: reason.name })
                  : reason.name,
              })),
            ]}
            value={reasonId}
            onValueChange={(value) => {
              setReasonId(value);
            }}
          />
          <Input
            label={t("office.disaggregation.filters.docNo")}
            placeholder={t("office.disaggregation.filters.docNoPlaceholder")}
            value={docNo}
            onChange={(event) => setDocNo(event.target.value)}
          />
          <DateRange
            label={t("office.disaggregation.filters.period")}
            fromLabel={t("office.disaggregation.filters.from")}
            toLabel={t("office.disaggregation.filters.to")}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            error={reversed ? t("office.disaggregation.filters.reversed") : undefined}
          />
        </ListFilters>
        {content()}
      </ListCard>
    </>
  );
}
