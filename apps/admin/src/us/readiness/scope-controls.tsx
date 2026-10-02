import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import type { TraceabilityLot, UsProduct } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Kind = "product" | "lot";
type Option = { value: string; label: string };
type PickerRecord = UsProduct | TraceabilityLot;
const LIMIT = 50;

/** Search is bounded; the selected record stays readable when its page changes. */
export function ReadinessScopePicker({
  client,
  kind,
  value,
  onChange,
  onSessionLost,
  onForbidden,
}: {
  client: UsBrowserClient;
  kind: Kind;
  value: string;
  onChange: (id: string) => void;
  onSessionLost: () => void;
  onForbidden: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<PickerRecord[]>([]);
  const [selected, setSelected] = useState<{ value: string; record: PickerRecord | null } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [searched, setSearched] = useState(false);
  const listRun = useRef(0);
  const labelRun = useRef(0);

  const toOption = useCallback(
    (row: PickerRecord): Option => {
      if ("name" in row) return { value: row.id, label: `${row.name} · ${row.id}` };
      const source = row.source
        ? row.source.kind === "location"
          ? `${t("lots.location")} ${row.source.locationId}`
          : `${t("lots.reference")} · ${
              row.source.resolvedLocationId
                ? `${t("lots.resolvedLocation")} ${row.source.resolvedLocationId}`
                : t("usReadiness.rules.source_unresolved")
            }`
        : t("lots.absent");
      return {
        value: row.id,
        label: `${row.tlc} · ${t("lots.source")}: ${source} · ${row.id}`,
      };
    },
    [t],
  );

  const load = useCallback(async () => {
    if (!searched) return;
    const token = ++listRun.current;
    setPending(true);
    setFailed(false);
    try {
      const query = { search, limit: LIMIT, offset };
      const response =
        kind === "product"
          ? await client.listProducts({ ...query, archived: "all" })
          : await client.listLots(query);
      if (token !== listRun.current) return;
      setRows(response.items);
    } catch (cause) {
      if (token !== listRun.current) return;
      setRows([]);
      setFailed(true);
      if (cause instanceof UsClientError && cause.code === "session_required") onSessionLost();
      if (cause instanceof UsClientError && cause.code === "forbidden") void onForbidden();
    } finally {
      if (token === listRun.current) setPending(false);
    }
  }, [client, kind, offset, onForbidden, onSessionLost, search, searched]);

  useEffect(() => {
    void load();
    return () => {
      listRun.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!value || selected?.value === value) return;
    const token = ++labelRun.current;
    const lookup = kind === "product" ? client.getProduct(value) : client.getLot(value);
    void lookup
      .then((record) => {
        if (token !== labelRun.current) return;
        setSelected({ value, record });
      })
      .catch((cause: unknown) => {
        if (token !== labelRun.current) return;
        if (cause instanceof UsClientError && cause.code === "session_required") onSessionLost();
        if (cause instanceof UsClientError && cause.code === "forbidden") void onForbidden();
        setSelected({ value, record: null });
      });
    return () => {
      labelRun.current += 1;
    };
  }, [client, kind, onForbidden, onSessionLost, selected?.value, value]);

  const label = t(kind === "product" ? "usReadiness.product" : "usReadiness.lot");
  const searchLabel = t(
    kind === "product" ? "usReadiness.searchProducts" : "usReadiness.searchLots",
  );
  const options = [
    { value: "", label: t("usReadiness.allRecords") },
    ...(value && !rows.some((row) => row.id === value)
      ? [
          {
            value,
            label:
              selected?.value === value && selected.record
                ? toOption(selected.record).label
                : value,
          },
        ]
      : []),
    ...rows.map(toOption),
  ];

  function searchNow() {
    setOffset(0);
    setSearch(draft.trim());
    setSearched(true);
    if (searched && search === draft.trim() && offset === 0) void load();
  }

  return (
    <fieldset className="us-readiness-picker">
      <legend>{label}</legend>
      <div className="us-readiness-picker-search">
        <Input
          label={searchLabel}
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!pending && !event.nativeEvent.isComposing) searchNow();
          }}
        />
        <Button type="button" variant="secondary" disabled={pending} onClick={searchNow}>
          {searchLabel}
        </Button>
      </div>
      {failed ? <p role="alert">{t("usReadiness.lookupError")}</p> : null}
      <Select
        native
        label={label}
        value={value}
        disabled={pending}
        onValueChange={(id) => {
          const record = rows.find((row) => row.id === id);
          setSelected(record ? { value: id, record } : selected?.value === id ? selected : null);
          onChange(id);
        }}
        options={options}
      />
      {searched && !pending && !failed && rows.length === 0 ? (
        <p>{t("usReadiness.noChoices")}</p>
      ) : null}
      {searched && (offset > 0 || rows.length === LIMIT) ? (
        <div className="us-readiness-picker-pages">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={pending || offset === 0}
            onClick={() => setOffset((old) => Math.max(0, old - LIMIT))}
          >
            {t("usReadiness.previous")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={pending || rows.length < LIMIT || offset >= 100000 - LIMIT}
            onClick={() => setOffset((old) => old + LIMIT)}
          >
            {t("usReadiness.next")}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
