import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import "./references.css";

export type ReceivingReferenceKind = "product" | "location" | "lot" | "document" | "party";
type LocationRole = "receive_at" | "tlc_source" | "supplier";
type ReferenceOption = { value: string; label: string };

const SEARCH_KEYS: Record<ReceivingReferenceKind, string> = {
  product: "receivingRef.searchProduct",
  location: "receivingRef.searchLocation",
  lot: "receivingRef.searchLot",
  document: "receivingRef.searchDocument",
  party: "receivingRef.searchParty",
};

async function listOptions(
  client: UsBrowserClient,
  kind: ReceivingReferenceKind,
  search: string,
  offset: number,
  productId: string | undefined,
  roles: readonly LocationRole[],
): Promise<ReferenceOption[]> {
  const common = { search, limit: 50, offset };
  switch (kind) {
    case "product": {
      const result = await client.listProducts({ ...common, archived: "false" });
      return result.items.map((row) => ({ value: row.id, label: row.name }));
    }
    case "location": {
      const result = await client.listLocations({
        ...common,
        archived: "false",
        ...(roles.length > 0 ? { roles: [...roles] } : {}),
      });
      return result.items.map((row) => ({ value: row.id, label: row.name }));
    }
    case "lot": {
      const result = await client.listLots({
        ...common,
        status: "active",
        ...(productId ? { productId } : {}),
      });
      return result.items.map((row) => ({ value: row.id, label: row.tlc }));
    }
    case "document": {
      const result = await client.listReferenceDocuments({ ...common, archived: "false" });
      return result.items.map((row) => ({ value: row.id, label: row.number }));
    }
    case "party": {
      const result = await client.listParties({ ...common, archived: "false" });
      return result.items.map((row) => ({ value: row.id, label: row.name }));
    }
  }
}

async function getOptionLabel(
  client: UsBrowserClient,
  kind: ReceivingReferenceKind,
  id: string,
): Promise<string> {
  switch (kind) {
    case "product":
      return (await client.getProduct(id)).name;
    case "location":
      return (await client.getLocation(id)).name;
    case "lot":
      return (await client.getLot(id)).tlc;
    case "document":
      return (await client.getReferenceDocument(id)).number;
    case "party":
      return (await client.getParty(id)).name;
  }
}

function authFailure(errors: unknown[]): UsClientError | undefined {
  const clientErrors = errors.filter(
    (error): error is UsClientError => error instanceof UsClientError,
  );
  return (
    clientErrors.find((error) => error.code === "session_required") ??
    clientErrors.find((error) => error.code === "forbidden")
  );
}

/** Bounded active-record lookup; selected identity and its readable label survive page changes. */
export function ReceivingReferencePicker({
  client,
  kind,
  label,
  value,
  disabled,
  onChange,
  onSessionLost,
  onForbidden,
  productId,
  roles,
}: {
  client: UsBrowserClient;
  kind: ReceivingReferenceKind;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onSessionLost: () => void;
  onForbidden: () => Promise<void>;
  productId?: string;
  roles?: readonly LocationRole[];
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ReferenceOption[]>([]);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const rolesKey = roles?.join(",") ?? "";

  const load = useCallback(async () => {
    const current = ++generation.current;
    setPending(true);
    setFailed(false);
    const normalizedRoles = rolesKey ? (rolesKey.split(",") as LocationRole[]) : [];
    const [listResult, selectedResult] = await Promise.allSettled([
      listOptions(client, kind, search, offset, productId, normalizedRoles),
      value ? getOptionLabel(client, kind, value) : Promise.resolve(""),
    ]);
    if (generation.current !== current) return;

    const failures = [listResult, selectedResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    const auth = authFailure(failures);
    if (auth?.code === "session_required") onSessionLost();
    if (auth?.code === "forbidden") await onForbidden();
    if (generation.current !== current) return;

    if (listResult.status === "fulfilled") setRows(listResult.value);
    else setRows([]);
    if (selectedResult.status === "fulfilled") setSelectedLabel(selectedResult.value);
    else setSelectedLabel("");
    setFailed(listResult.status === "rejected" || auth !== undefined);
    setPending(false);
  }, [client, kind, offset, onForbidden, onSessionLost, productId, rolesKey, search, value]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  function applySearch() {
    if (pending || disabled) return;
    setOffset(0);
    setSearch(draft.trim());
  }

  const selectedOnPage = rows.some((row) => row.value === value);
  const options: ReferenceOption[] = [
    { value: "", label: t("receivingRef.choose") },
    ...(value && !selectedOnPage
      ? [
          {
            value,
            label: selectedLabel || t("receivingRef.selectedId", { id: value }),
          },
        ]
      : []),
    ...rows,
  ];

  return (
    <fieldset className="us-receiving-reference" disabled={disabled}>
      <legend>{label}</legend>
      <div className="us-md-filter-row">
        <Input
          label={t(SEARCH_KEYS[kind])}
          value={draft}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (event.nativeEvent.isComposing) return;
            applySearch();
          }}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={pending || disabled}
          onClick={applySearch}
        >
          {t("receivingRef.search")}
        </Button>
      </div>
      {failed ? (
        <div role="alert">
          <p>{t("receivingRef.loadError")}</p>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || disabled}
            onClick={() => void load()}
          >
            {t("receivingRef.retry")}
          </Button>
        </div>
      ) : null}
      <Select
        native
        aria-label={label}
        value={value}
        disabled={pending || failed || disabled}
        onValueChange={onChange}
        options={options}
      />
      {!pending && !failed && rows.length === 0 ? <p>{t("receivingRef.noChoices")}</p> : null}
      {offset > 0 || rows.length === 50 ? (
        <div className="us-md-pager">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={pending || failed || disabled || offset === 0}
            onClick={() => setOffset((current) => Math.max(0, current - 50))}
          >
            {t("receivingRef.previousPage")}
          </Button>
          <span>{t("receivingRef.page", { page: offset / 50 + 1 })}</span>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={pending || failed || disabled || rows.length < 50 || offset >= 100000}
            onClick={() => setOffset((current) => current + 50)}
          >
            {t("receivingRef.nextPage")}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
