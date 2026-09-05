import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Select,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";
import { type TraceabilityLocationRole } from "@markiro/domain";
import type {
  CreateUsLocation,
  UpdateUsLocation,
  UsLocation,
  UsParty,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { locationRoles } from "./forms.js";
import { LocationForm, type LocationSaveResult } from "./location-form.js";
import {
  locationCityRegion,
  Pager,
  roleKeys,
  type ArchiveFilter,
  type MasterDataViewProps,
} from "./workspace-shared.js";

type LocationEditor = { location?: UsLocation; parent?: UsParty };
type SelectedLocation = { location: UsLocation; parent: UsParty };

export function LocationsView({
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
  const filterPartyRun = useRef(0);
  const partyIdRef = useRef("");
  const listPresent = useRef(false);

  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState<ArchiveFilter>("false");
  const [offset, setOffset] = useState(0);
  const [partyId, setPartyId] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<TraceabilityLocationRole[]>([]);
  const [locations, setLocations] = useState<UsLocation[]>([]);
  const [parents, setParents] = useState<Record<string, UsParty>>({});
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [editor, setEditor] = useState<LocationEditor | null>(null);
  const [selected, setSelected] = useState<SelectedLocation | null>(null);

  const [filterPartyDraft, setFilterPartyDraft] = useState("");
  const [filterPartySearch, setFilterPartySearch] = useState("");
  const [filterPartyOptions, setFilterPartyOptions] = useState<UsParty[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listRun.current += 1;
      detailRun.current += 1;
      filterPartyRun.current += 1;
    };
  }, []);

  const loadLocations = useCallback(async () => {
    const run = ++listRun.current;
    setLoading(true);
    setStale(listPresent.current);
    setError(false);
    try {
      const result = await client.listLocations({
        archived,
        ...(search ? { search } : {}),
        ...(partyId ? { partyId } : {}),
        ...(selectedRoles.length ? { roles: selectedRoles } : {}),
        limit: 50,
        offset,
      });
      const ids = [...new Set(result.items.map((item) => item.partyId))];
      const resolved = await Promise.all(ids.map((id) => client.getParty(id)));
      if (!alive.current || run !== listRun.current) return;
      setParents(Object.fromEntries(resolved.map((party) => [party.id, party])));
      setLocations(result.items);
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
  }, [archived, client, offset, onClientFailure, partyId, search, selectedRoles]);

  useEffect(() => {
    void loadLocations();
    return () => {
      listRun.current += 1;
    };
  }, [loadLocations]);

  const loadFilterParties = useCallback(async () => {
    const run = ++filterPartyRun.current;
    try {
      const result = await client.listParties({
        archived: "all",
        ...(filterPartySearch ? { search: filterPartySearch } : {}),
        limit: 50,
        offset: 0,
      });
      if (alive.current && run === filterPartyRun.current)
        setFilterPartyOptions((current) => {
          const selectedParty = current.find((party) => party.id === partyIdRef.current);
          if (!selectedParty || result.items.some((party) => party.id === selectedParty.id))
            return result.items;
          return [selectedParty, ...result.items];
        });
    } catch (cause) {
      if (alive.current && run === filterPartyRun.current) onClientFailure(cause, "md.loadError");
    }
  }, [client, filterPartySearch, onClientFailure]);

  useEffect(() => {
    void loadFilterParties();
    return () => {
      filterPartyRun.current += 1;
    };
  }, [loadFilterParties]);

  const openLocation = useCallback(
    async (location: UsLocation) => {
      const run = ++detailRun.current;
      try {
        const [fresh, parent] = await Promise.all([
          client.getLocation(location.id),
          client.getParty(location.partyId),
        ]);
        if (alive.current && run === detailRun.current) setSelected({ location: fresh, parent });
      } catch (cause) {
        if (alive.current && run === detailRun.current) onClientFailure(cause, "md.loadError");
      }
    },
    [client, onClientFailure],
  );

  async function saveLocation(
    value: CreateUsLocation | UpdateUsLocation,
  ): Promise<LocationSaveResult> {
    try {
      if (editor?.location) await client.updateLocation(editor.location.id, value);
      else await client.createLocation(value);
      setEditor(null);
      onDirtyChange(false);
      onNotice("status", "md.savedLocation");
      await loadLocations();
      return "saved";
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "session_required") {
        onSessionLost();
        return "failed";
      }
      if (cause instanceof UsClientError && cause.code === "party_archived") {
        const parentId = "partyId" in value ? value.partyId : editor?.location?.partyId;
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

  async function archiveLocation(item: SelectedLocation) {
    const key = item.location.archived ? "restoreLocationConfirm" : "archiveLocationConfirm";
    if (!window.confirm(t(`md.${key}`))) return;
    setArchivePending(true);
    const releaseMutation = beginMutation();
    try {
      await client.updateLocation(item.location.id, { archived: !item.location.archived });
      setSelected(null);
      onNotice(
        "status",
        item.location.archived ? "md.restoredLocationNotice" : "md.archivedLocationNotice",
      );
      await loadLocations();
    } catch (cause) {
      if (cause instanceof UsClientError && cause.code === "forbidden") await onForbidden();
      else onClientFailure(cause, "md.saveFailed");
    } finally {
      setArchivePending(false);
      releaseMutation();
    }
  }

  const columns = useMemo<TableColumn<UsLocation>[]>(
    () => [
      {
        key: "name",
        title: t("md.internalName"),
        render: (location) => (
          <Button
            className="us-md-link"
            variant="secondary"
            size="compact"
            disabled={mutationPending}
            onClick={() => void openLocation(location)}
          >
            {location.name}
          </Button>
        ),
      },
      { key: "businessName", title: t("md.businessName") },
      {
        key: "partyId",
        title: t("md.party"),
        render: (location) => parents[location.partyId]?.name ?? location.partyId,
      },
      { key: "city", title: t("md.city"), render: locationCityRegion },
      {
        key: "roles",
        title: t("md.roles"),
        wrap: true,
        render: (location) =>
          location.roles.map((role) => t(`md.${roleKeys[role]}`)).join(" · ") || "—",
      },
      {
        key: "readiness",
        title: t("md.readiness"),
        render: (location) => (
          <StatusChip
            status={location.descriptionStatus.exportReady ? "ok" : "warn"}
            label={t(location.descriptionStatus.exportReady ? "md.complete" : "md.incomplete")}
          />
        ),
      },
    ],
    [mutationPending, openLocation, parents, t],
  );

  return (
    <>
      <header className="us-md-page-header">
        <div>
          <h1>{t("md.locations")}</h1>
          <p>{t("md.locationsIntro")}</p>
        </div>
        {canWrite ? (
          <Button disabled={mutationPending} onClick={() => setEditor({})}>
            {t("md.addLocation")}
          </Button>
        ) : null}
      </header>
      <form
        className="us-md-filters us-md-filters--locations"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setOffset(0);
          setSearch(draft.trim());
        }}
      >
        <Input
          label={t("md.searchLocations")}
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
        <div className="us-md-filter-party">
          <Input
            label={t("md.searchParents")}
            value={filterPartyDraft}
            onChange={(event) => setFilterPartyDraft(event.target.value)}
          />
          <Button variant="secondary" onClick={() => setFilterPartySearch(filterPartyDraft.trim())}>
            {t("md.search")}
          </Button>
        </div>
        <Select
          native
          label={t("md.party")}
          value={partyId}
          onValueChange={(value) => {
            setOffset(0);
            partyIdRef.current = value;
            setPartyId(value);
          }}
          options={[
            { value: "", label: t("md.all") },
            ...filterPartyOptions.map((party) => ({ value: party.id, label: party.name })),
          ]}
        />
        <Button type="submit" variant="secondary">
          {t("md.search")}
        </Button>
      </form>
      <fieldset className="us-md-role-filters">
        <legend>{t("md.roles")}</legend>
        {locationRoles.map((role) => (
          <Checkbox
            key={role}
            label={t(`md.${roleKeys[role]}`)}
            checked={selectedRoles.includes(role)}
            onCheckedChange={(checked) => {
              setOffset(0);
              setSelectedRoles((current) =>
                checked ? [...current, role] : current.filter((item) => item !== role),
              );
            }}
          />
        ))}
      </fieldset>
      {stale ? <p role="status">{t("md.stale")}</p> : null}
      {error ? (
        <div className="us-md-list-state" role="alert">
          <p>{t("md.loadError")}</p>
          <Button variant="secondary" onClick={() => void loadLocations()}>
            {t("md.retry")}
          </Button>
        </div>
      ) : loading && !locations.length ? (
        <p role="status">{t("md.accessLoading")}</p>
      ) : (
        <Table
          columns={columns}
          rows={locations}
          empty={t("md.emptyLocations")}
          scrollLabel={t("md.locations")}
        />
      )}
      <Pager
        page={offset / 50 + 1}
        hasPrevious={offset > 0}
        hasNext={locations.length === 50}
        disabled={loading}
        onPrevious={() => setOffset((value) => Math.max(0, value - 50))}
        onNext={() => setOffset((value) => value + 50)}
      />

      {editor ? (
        <LocationForm
          key={editor.location?.id ?? editor.parent?.id ?? "new"}
          client={client}
          {...(editor.location ? { location: editor.location } : {})}
          {...(editor.parent ? { parent: editor.parent } : {})}
          canWrite={canWrite}
          onSave={saveLocation}
          onClose={() => {
            setEditor(null);
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
          title={selected.location.name}
          closeLabel={t("md.closeLocationDetails")}
          onClose={() => {
            if (!archivePending) setSelected(null);
          }}
          className="us-md-drawer"
          footer={
            canWrite ? (
              <>
                {!selected.parent.archived ? (
                  <Button
                    variant="secondary"
                    disabled={mutationPending}
                    onClick={() => {
                      setEditor(selected);
                      setSelected(null);
                    }}
                  >
                    {t("md.editLocation")}
                  </Button>
                ) : null}
                {!selected.location.archived || !selected.parent.archived ? (
                  <Button
                    variant={selected.location.archived ? "secondary" : "destructive-outline"}
                    disabled={mutationPending}
                    onClick={() => void archiveLocation(selected)}
                  >
                    {t(selected.location.archived ? "md.restoreLocation" : "md.archiveLocation")}
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          {selected.parent.archived ? (
            <p className="us-md-notice us-md-notice--alert">
              {t(selected.location.archived ? "md.archivedParentEdit" : "md.parentArchived")}
            </p>
          ) : null}
          <dl className="us-md-detail-list">
            <dt>{t("md.party")}</dt>
            <dd>{selected.parent.name}</dd>
            <dt>{t("md.businessName")}</dt>
            <dd>{selected.location.businessName}</dd>
            <dt>{t("md.phoneNumber")}</dt>
            <dd>{selected.location.phoneNumber ?? "—"}</dd>
            {selected.location.addressKind === "street" ? (
              <>
                <dt>{t("md.streetAddress")}</dt>
                <dd>{selected.location.streetAddress ?? "—"}</dd>
              </>
            ) : (
              <>
                <dt>{t("md.latitude")}</dt>
                <dd>{selected.location.latitude ?? "—"}</dd>
                <dt>{t("md.longitude")}</dt>
                <dd>{selected.location.longitude ?? "—"}</dd>
              </>
            )}
            <dt>{t("md.city")}</dt>
            <dd>{locationCityRegion(selected.location)}</dd>
            <dt>{t("md.zipOrPostalCode")}</dt>
            <dd>{selected.location.zipOrPostalCode ?? "—"}</dd>
            <dt>{t("md.countryCode")}</dt>
            <dd>{selected.location.countryCode ?? "—"}</dd>
            <dt>{t("md.roles")}</dt>
            <dd>
              {selected.location.roles.map((role) => t(`md.${roleKeys[role]}`)).join(" · ") || "—"}
            </dd>
            <dt>{t("md.readiness")}</dt>
            <dd>
              {t(selected.location.descriptionStatus.exportReady ? "md.complete" : "md.incomplete")}
              {selected.location.descriptionStatus.issues.length ? (
                <>
                  {" · "}
                  {t("md.missingDescription")}{" "}
                  {selected.location.descriptionStatus.issues
                    .map((issue) =>
                      t(`md.field${issue.field[0]?.toUpperCase()}${issue.field.slice(1)}`),
                    )
                    .join(", ")}
                  .
                </>
              ) : null}
            </dd>
          </dl>
        </Drawer>
      ) : null}
    </>
  );
}
