import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Drawer, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type {
  CreateUsLocation,
  CreateUsParty,
  UpdateUsLocation,
  UsLocation,
  UsParty,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { LocationForm, type LocationSaveResult } from "./location-form.js";
import { PartyForm, type PartySaveResult } from "./party-form.js";
import {
  Pager,
  partyContact,
  type ArchiveFilter,
  type MasterDataViewProps,
} from "./workspace-shared.js";

export function PartiesView({
  client,
  canWrite,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onNotice,
  onForbidden,
  onClientFailure,
  onSessionLost,
}: MasterDataViewProps) {
  const { t } = useTranslation();
  const alive = useRef(true);
  const listRun = useRef(0);
  const detailRun = useRef(0);
  const childListRun = useRef(0);
  const listPresent = useRef(false);
  const childListPresent = useRef(false);

  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<ArchiveFilter>("false");
  const [offset, setOffset] = useState(0);
  const [parties, setParties] = useState<UsParty[]>([]);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [editor, setEditor] = useState<"new" | UsParty | null>(null);
  const [selected, setSelected] = useState<UsParty | null>(null);
  const [locationEditorParent, setLocationEditorParent] = useState<UsParty | null>(null);

  const [childLocations, setChildLocations] = useState<UsLocation[]>([]);
  const [childOffset, setChildOffset] = useState(0);
  const [childLoading, setChildLoading] = useState(false);
  const [childError, setChildError] = useState(false);
  const [childStale, setChildStale] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listRun.current += 1;
      detailRun.current += 1;
      childListRun.current += 1;
    };
  }, []);

  const loadParties = useCallback(async () => {
    const run = ++listRun.current;
    setLoading(true);
    setStale(listPresent.current);
    setError(false);
    try {
      const result = await client.listParties({
        archived,
        ...(search ? { search } : {}),
        limit: 50,
        offset,
      });
      if (!alive.current || run !== listRun.current) return;
      setParties(result.items);
      listPresent.current = result.items.length > 0;
    } catch (cause) {
      if (!alive.current || run !== listRun.current) return;
      setError(true);
      onClientFailure(cause, "md.loadError");
    } finally {
      if (alive.current && run === listRun.current) {
        setLoading(false);
        setStale(false);
      }
    }
  }, [archived, client, offset, onClientFailure, search]);

  useEffect(() => {
    void loadParties();
    return () => {
      listRun.current += 1;
    };
  }, [loadParties]);

  const openParty = useCallback(
    async (party: UsParty) => {
      const run = ++detailRun.current;
      childListRun.current += 1;
      childListPresent.current = false;
      setChildOffset(0);
      setChildLocations([]);
      setChildError(false);
      setChildStale(false);
      try {
        const fresh = await client.getParty(party.id);
        if (alive.current && run === detailRun.current) setSelected(fresh);
      } catch (cause) {
        if (alive.current && run === detailRun.current) onClientFailure(cause, "md.loadError");
      }
    },
    [client, onClientFailure],
  );

  async function saveParty(value: CreateUsParty): Promise<PartySaveResult> {
    try {
      if (editor === "new") await client.createParty(value);
      else if (editor) await client.updateParty(editor.id, value);
      else return "failed";
      setEditor(null);
      onDirtyChange(false);
      onNotice("status", "md.savedParty");
      await loadParties();
      return "saved";
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "session_required") {
        onSessionLost();
        return "failed";
      }
      if (cause instanceof UsClientError && cause.code === "conflict") return "conflict";
      if (cause instanceof UsClientError && cause.code === "forbidden") {
        await onForbidden();
        return "forbidden";
      }
      onNotice("alert", "md.saveFailed");
      return "failed";
    }
  }

  async function archiveParty(party: UsParty) {
    const key = party.archived ? "restorePartyConfirm" : "archivePartyConfirm";
    if (!window.confirm(t(`md.${key}`))) return;
    setArchivePending(true);
    const releaseMutation = beginMutation();
    try {
      await client.updateParty(party.id, { archived: !party.archived });
      setSelected(null);
      onNotice("status", party.archived ? "md.restoredPartyNotice" : "md.archivedPartyNotice");
      await loadParties();
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "forbidden") await onForbidden();
      else onClientFailure(cause, "md.saveFailed");
    } finally {
      setArchivePending(false);
      releaseMutation();
    }
  }

  const loadChildLocations = useCallback(async () => {
    if (!selected) return;
    const run = ++childListRun.current;
    setChildLoading(true);
    setChildStale(childListPresent.current);
    setChildError(false);
    try {
      const result = await client.listLocations({
        archived: "all",
        partyId: selected.id,
        limit: 50,
        offset: childOffset,
      });
      if (!alive.current || run !== childListRun.current) return;
      setChildLocations(result.items);
      childListPresent.current = result.items.length > 0;
    } catch (cause) {
      if (!alive.current || run !== childListRun.current) return;
      setChildError(true);
      if (cause instanceof UsClientError && cause.code === "session_required")
        onClientFailure(cause, "md.loadError");
    } finally {
      if (alive.current && run === childListRun.current) {
        setChildLoading(false);
        setChildStale(false);
      }
    }
  }, [childOffset, client, onClientFailure, selected]);

  useEffect(() => {
    void loadChildLocations();
    return () => {
      childListRun.current += 1;
    };
  }, [loadChildLocations]);

  async function saveChildLocation(
    value: CreateUsLocation | UpdateUsLocation,
  ): Promise<LocationSaveResult> {
    try {
      await client.createLocation(value);
      setLocationEditorParent(null);
      onDirtyChange(false);
      onNotice("status", "md.savedLocation");
      return "saved";
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "session_required") {
        onSessionLost();
        return "failed";
      }
      if (cause instanceof UsClientError && cause.code === "party_archived") {
        const parentId = locationEditorParent?.id ?? ("partyId" in value ? value.partyId : null);
        if (!parentId) return "failed";
        try {
          return { status: "party_archived", parent: await client.getParty(parentId) };
        } catch (parentCause) {
          onClientFailure(parentCause, "md.loadError");
          return "failed";
        }
      }
      if (cause instanceof UsClientError && cause.code === "forbidden") {
        await onForbidden();
        return "forbidden";
      }
      onNotice("alert", "md.saveFailed");
      return "failed";
    }
  }

  const columns = useMemo<TableColumn<UsParty>[]>(
    () => [
      {
        key: "name",
        title: t("md.name"),
        render: (party) => (
          <Button
            className="us-md-link"
            variant="secondary"
            size="compact"
            disabled={mutationPending}
            onClick={() => void openParty(party)}
          >
            {party.name}
          </Button>
        ),
      },
      { key: "legalName", title: t("md.legalName"), render: (party) => party.legalName ?? "—" },
      { key: "contact", title: t("md.contact"), render: partyContact },
      {
        key: "archived",
        title: t("md.status"),
        render: (party) => (
          <StatusChip
            status={party.archived ? "neutral" : "ok"}
            label={t(party.archived ? "md.archived" : "md.active")}
          />
        ),
      },
      { key: "actions", title: t("md.actions"), render: () => "›" },
    ],
    [mutationPending, openParty, t],
  );

  return (
    <>
      <header className="us-md-page-header">
        <div>
          <h1>{t("md.parties")}</h1>
          <p>{t("md.partiesIntro")}</p>
        </div>
        {canWrite ? (
          <Button disabled={mutationPending} onClick={() => setEditor("new")}>
            {t("md.addParty")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-md-filters"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setOffset(0);
          setSearch(draft.trim());
        }}
      >
        <Input
          label={t("md.searchParties")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Select
          native
          label={t("md.status")}
          value={archived}
          onValueChange={(value) => {
            setOffset(0);
            setArchived(value);
          }}
          options={[
            { value: "false", label: t("md.active") },
            { value: "true", label: t("md.archived") },
            { value: "all", label: t("md.all") },
          ]}
        />
        <Button type="submit" variant="secondary">
          {t("md.search")}
        </Button>
      </form>
      {stale ? <p role="status">{t("md.stale")}</p> : null}
      {error ? (
        <div className="us-md-list-state" role="alert">
          <p>{t("md.loadError")}</p>
          <Button variant="secondary" onClick={() => void loadParties()}>
            {t("md.retry")}
          </Button>
        </div>
      ) : loading && !parties.length ? (
        <p role="status">{t("md.accessLoading")}</p>
      ) : (
        <Table
          columns={columns}
          rows={parties}
          empty={t("md.emptyParties")}
          scrollLabel={t("md.parties")}
        />
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={parties.length === 50}
        disabled={loading}
        onPrevious={() => setOffset((value) => Math.max(0, value - 50))}
        onNext={() => setOffset((value) => value + 50)}
      />

      {editor ? (
        <PartyForm
          key={editor === "new" ? "new" : editor.id}
          {...(editor === "new" ? {} : { party: editor })}
          canWrite={canWrite}
          onSave={saveParty}
          onClose={() => {
            setEditor(null);
            onDirtyChange(false);
          }}
          beginMutation={beginMutation}
          onDirtyChange={onDirtyChange}
        />
      ) : null}

      {locationEditorParent ? (
        <LocationForm
          key={locationEditorParent.id}
          client={client}
          parent={locationEditorParent}
          canWrite={canWrite}
          onSave={saveChildLocation}
          onClose={() => {
            setLocationEditorParent(null);
            onDirtyChange(false);
          }}
          beginMutation={beginMutation}
          onDirtyChange={onDirtyChange}
          onSessionLost={onSessionLost}
        />
      ) : null}

      {selected ? (
        <Drawer
          open
          title={selected.name}
          closeLabel={t("md.closePartyDetails")}
          onClose={() => {
            if (!archivePending) setSelected(null);
          }}
          className="us-md-drawer"
          footer={
            canWrite ? (
              <>
                <Button
                  variant="secondary"
                  disabled={mutationPending}
                  onClick={() => {
                    setEditor(selected);
                    setSelected(null);
                  }}
                >
                  {t("md.editParty")}
                </Button>
                <Button
                  variant={selected.archived ? "secondary" : "destructive-outline"}
                  disabled={mutationPending}
                  onClick={() => void archiveParty(selected)}
                >
                  {t(selected.archived ? "md.restoreParty" : "md.archiveParty")}
                </Button>
              </>
            ) : null
          }
        >
          <dl className="us-md-detail-list">
            <dt>{t("md.legalName")}</dt>
            <dd>{selected.legalName ?? "—"}</dd>
            <dt>{t("md.contact")}</dt>
            <dd>{selected.contactName ?? "—"}</dd>
            <dt>{t("md.contactPhone")}</dt>
            <dd>{selected.contactPhone ?? "—"}</dd>
            <dt>{t("md.contactEmail")}</dt>
            <dd>{selected.contactEmail ?? "—"}</dd>
            <dt>{t("md.notes")}</dt>
            <dd>{selected.notes ?? "—"}</dd>
            <dt>{t("md.status")}</dt>
            <dd>{t(selected.archived ? "md.archived" : "md.active")}</dd>
          </dl>
          <div className="us-md-detail-heading">
            <h3>{t("md.partyLocations")}</h3>
            {canWrite && !selected.archived ? (
              <Button
                size="compact"
                disabled={mutationPending}
                onClick={() => {
                  setLocationEditorParent(selected);
                  setSelected(null);
                }}
              >
                {t("md.addLocation")}
              </Button>
            ) : null}
          </div>
          {childStale ? <p role="status">{t("md.stale")}</p> : null}
          {childError ? (
            <div className="us-md-list-state" role="alert">
              <p>{t("md.loadError")}</p>
              <Button variant="secondary" onClick={() => void loadChildLocations()}>
                {t("md.retry")}
              </Button>
            </div>
          ) : childLoading && !childLocations.length ? (
            <p role="status">{t("md.accessLoading")}</p>
          ) : !childLocations.length ? (
            <p>{t("md.noPartyLocations")}</p>
          ) : null}
          {!childError ? (
            <>
              <div className="us-md-detail-rows">
                {childLocations.map((location) => (
                  <span key={location.id}>{location.name}</span>
                ))}
              </div>
              <Pager
                page={childOffset / 50 + 1}
                hasPrevious={childOffset > 0}
                hasNext={childLocations.length === 50}
                disabled={childLoading}
                onPrevious={() => setChildOffset((value) => Math.max(0, value - 50))}
                onNext={() => setChildOffset((value) => value + 50)}
              />
            </>
          ) : null}
        </Drawer>
      ) : null}
    </>
  );
}
