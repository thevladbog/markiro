import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { Pager } from "../master-data/workspace-shared.js";

/** Bounded active-record lookup; a selection survives searches and page changes. */
export function LotReferencePicker({
  client,
  kind,
  label,
  value,
  disabled,
  onChange,
  onSessionLost,
  onForbidden,
}: {
  client: UsBrowserClient;
  kind: "product" | "location";
  label: string;
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onSessionLost: () => void;
  onForbidden: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<{ value: string; label: string }[]>([]);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const run = useRef(0);
  const load = useCallback(async () => {
    const current = ++run.current;
    setPending(true);
    setFailed(false);
    try {
      const query = { archived: "false", search, limit: 50, offset };
      const result =
        kind === "product" ? await client.listProducts(query) : await client.listLocations(query);
      if (run.current !== current) return;
      setRows(result.items.map((row) => ({ value: row.id, label: row.name })));
    } catch (error) {
      if (run.current !== current) return;
      setRows([]);
      setFailed(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      if (run.current === current) setPending(false);
    }
  }, [client, kind, offset, search, onForbidden, onSessionLost]);
  useEffect(() => {
    void load();
    return () => {
      run.current += 1;
    };
  }, [load]);
  return (
    <fieldset className="us-lot-picker" disabled={disabled}>
      <legend>{label}</legend>
      <div className="us-md-filter-row">
        <Input
          label={t(kind === "product" ? "lots.productSearch" : "lots.locationSearch")}
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (pending || disabled || event.nativeEvent.isComposing) return;
            setOffset(0);
            setSearch(draft.trim());
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={pending || disabled}
          onClick={() => {
            setOffset(0);
            setSearch(draft.trim());
          }}
        >
          {t("md.search")}
        </Button>
      </div>
      {failed ? (
        <div role="alert">
          <p>{t("lots.referenceLoadError")}</p>
          <Button type="button" disabled={pending || disabled} onClick={() => void load()}>
            {t("md.retry")}
          </Button>
        </div>
      ) : null}
      <Select
        native
        label={label}
        value={value}
        disabled={pending || failed || disabled}
        onValueChange={onChange}
        options={[
          { value: "", label: t("lots.choose") },
          ...(value && !rows.some((row) => row.value === value)
            ? [{ value, label: t("lots.selectedId", { id: value }) }]
            : []),
          ...rows,
        ]}
      />
      {!pending && !failed && rows.length === 0 ? <p>{t("lots.noChoices")}</p> : null}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={rows.length === 50 && offset < 100000}
        disabled={pending || failed || disabled}
        onPrevious={() => setOffset((n) => Math.max(0, n - 50))}
        onNext={() => setOffset((n) => n + 50)}
      />
    </fieldset>
  );
}
