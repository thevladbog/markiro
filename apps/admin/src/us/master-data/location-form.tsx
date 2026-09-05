import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Checkbox, Drawer, Input, Select } from "@markiro/ui";
import type {
  CreateUsLocation,
  UpdateUsLocation,
  UsLocation,
  UsParty,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import {
  emptyLocationForm,
  locationDescriptionGaps,
  locationRoles,
  parseLocationForm,
  type FormErrorCode,
  type LocationFormValues,
} from "./forms.js";

export type LocationSaveResult =
  "saved" | "forbidden" | "failed" | { status: "party_archived"; parent: UsParty };

type LocationFormProps = {
  client: UsBrowserClient;
  location?: UsLocation;
  parent?: UsParty;
  canWrite: boolean;
  onSave: (value: CreateUsLocation | UpdateUsLocation) => Promise<LocationSaveResult>;
  onClose: () => void;
  beginMutation: () => () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSessionLost: () => void;
};

function initialValues(location?: UsLocation, parent?: UsParty): LocationFormValues {
  if (!location) {
    return { ...emptyLocationForm(), partyId: parent?.id ?? "", businessName: parent?.name ?? "" };
  }
  return {
    partyId: location.partyId,
    name: location.name,
    businessName: location.businessName,
    phoneNumber: location.phoneNumber ?? "",
    addressKind: location.addressKind,
    streetAddress: location.streetAddress ?? "",
    latitude: location.latitude ?? "",
    longitude: location.longitude ?? "",
    city: location.city ?? "",
    stateOrRegion: location.stateOrRegion ?? "",
    zipOrPostalCode: location.zipOrPostalCode ?? "",
    countryCode: location.countryCode ?? "",
    roles: [...location.roles],
  };
}

const roleKeys = {
  supplier: "roleSupplier",
  processor: "roleProcessor",
  ship_from: "roleShipFrom",
  receive_at: "roleReceiveAt",
  recipient: "roleRecipient",
  tlc_source: "roleTlcSource",
} as const;

export function LocationForm({
  client,
  location,
  parent,
  canWrite,
  onSave,
  onClose,
  beginMutation,
  onDirtyChange,
  onSessionLost,
}: LocationFormProps) {
  const { t } = useTranslation();
  const initial = useMemo(() => initialValues(location, parent), [location, parent]);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, FormErrorCode>>({});
  const [pending, setPending] = useState(false);
  const [parentDraft, setParentDraft] = useState("");
  const [parentSearch, setParentSearch] = useState("");
  const [parentOffset, setParentOffset] = useState(0);
  const [parentOptions, setParentOptions] = useState<UsParty[]>(parent ? [parent] : []);
  const [parentLoading, setParentLoading] = useState(!location && !parent);
  const [parentError, setParentError] = useState(false);
  const [refreshedParents, setRefreshedParents] = useState<Record<string, UsParty>>({});
  const parentLoad = useRef(0);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const gaps = locationDescriptionGaps(form);
  const archivedParent = refreshedParents[form.partyId];
  const selectedParentArchived = Boolean(
    archivedParent?.archived && archivedParent.id === form.partyId,
  );
  const visibleParentOptions = parentOptions.map((option) => refreshedParents[option.id] ?? option);
  if (archivedParent && !visibleParentOptions.some((option) => option.id === archivedParent.id))
    visibleParentOptions.unshift(archivedParent);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const loadParents = useCallback(async () => {
    if (location || parent) return;
    const run = ++parentLoad.current;
    setParentLoading(true);
    setParentError(false);
    try {
      const result = await client.listParties({
        archived: "false",
        ...(parentSearch ? { search: parentSearch } : {}),
        limit: 50,
        offset: parentOffset,
      });
      if (run === parentLoad.current) setParentOptions(result.items);
    } catch (error) {
      if (run !== parentLoad.current) return;
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      else setParentError(true);
    } finally {
      if (run === parentLoad.current) setParentLoading(false);
    }
  }, [client, location, onSessionLost, parent, parentOffset, parentSearch]);

  useEffect(() => {
    void loadParents();
    return () => {
      parentLoad.current += 1;
    };
  }, [loadParents]);

  function set<K extends keyof LocationFormValues>(field: K, value: LocationFormValues[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function selectParent(option: UsParty) {
    if (pending || option.archived) return;
    setForm((current) => ({
      ...current,
      partyId: option.id,
      businessName: current.businessName.trim() ? current.businessName : option.name,
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next.partyId;
      return next;
    });
  }

  function requestClose() {
    if (pending) return;
    if (dirty && !window.confirm(t("md.discardConfirm"))) return;
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !canWrite || selectedParentArchived) return;
    const parsed = parseLocationForm(form, location ? "edit" : "create");
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    const releaseMutation = beginMutation();
    setPending(true);
    try {
      const result = await onSave(parsed.value);
      if (typeof result === "object" && result.status === "party_archived")
        setRefreshedParents((current) => ({ ...current, [result.parent.id]: result.parent }));
    } finally {
      setPending(false);
      releaseMutation();
    }
  }

  const error = (field: keyof LocationFormValues) => {
    const code = errors[field];
    return code === "required"
      ? t("md.requiredError")
      : code === "format"
        ? t("md.formatError")
        : undefined;
  };
  const errorProps = (field: keyof LocationFormValues) => {
    const value = error(field);
    return value ? { error: value } : {};
  };
  const gapName = (field: string) => t(`md.field${field[0]?.toUpperCase()}${field.slice(1)}`);

  return (
    <Drawer
      open
      title={location ? t("md.editLocation") : t("md.addLocation")}
      closeLabel={t("md.close")}
      onClose={requestClose}
      className="us-md-drawer"
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={requestClose}>
            {t("md.cancel")}
          </Button>
          {canWrite ? (
            <Button
              type="submit"
              form="us-location-form"
              loading={pending}
              disabled={selectedParentArchived}
            >
              {t("md.saveLocation")}
            </Button>
          ) : null}
        </>
      }
    >
      <form id="us-location-form" className="us-md-form" onSubmit={(event) => void submit(event)}>
        <section className="us-md-form-section" aria-labelledby="us-md-location-identity">
          <h3 id="us-md-location-identity">{t("md.locationDetails")}</h3>
          {location || parent ? (
            <Input
              label={t("md.party")}
              value={archivedParent?.name ?? parent?.name ?? location?.partyId ?? ""}
              disabled
            />
          ) : (
            <fieldset className="us-md-parent-picker">
              <legend>{t("md.party")}</legend>
              <div className="us-md-filter-row">
                <Input
                  label={t("md.searchParents")}
                  disabled={pending}
                  value={parentDraft}
                  onChange={(event) => setParentDraft(event.target.value)}
                />
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setParentOffset(0);
                    setParentSearch(parentDraft.trim());
                  }}
                >
                  {t("md.search")}
                </Button>
              </div>
              {parentLoading ? <p>{t("md.accessLoading")}</p> : null}
              {parentError ? (
                <Button variant="secondary" disabled={pending} onClick={() => void loadParents()}>
                  {t("md.retry")}
                </Button>
              ) : null}
              {!parentLoading && !parentError && !parentOptions.length ? (
                <p>{t("md.parentSearchEmpty")}</p>
              ) : null}
              <div className="us-md-parent-options">
                {visibleParentOptions.map((option) => (
                  <Button
                    key={option.id}
                    variant="secondary"
                    disabled={pending || option.archived}
                    aria-pressed={form.partyId === option.id}
                    onClick={() => selectParent(option)}
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
              {error("partyId") ? <p className="us-md-field-error">{error("partyId")}</p> : null}
              <div className="us-md-pager">
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={pending || parentOffset === 0 || parentLoading}
                  onClick={() => setParentOffset((value) => Math.max(0, value - 50))}
                >
                  {t("md.previousPage")}
                </Button>
                <span>{t("md.page", { page: parentOffset / 50 + 1 })}</span>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={pending || parentOptions.length < 50 || parentLoading}
                  onClick={() => setParentOffset((value) => value + 50)}
                >
                  {t("md.nextPage")}
                </Button>
              </div>
            </fieldset>
          )}
          <div className="us-md-form-grid">
            <Input
              label={t("md.internalName")}
              disabled={pending}
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              {...errorProps("name")}
              required
            />
            <Input
              label={t("md.businessName")}
              disabled={pending}
              value={form.businessName}
              onChange={(event) => set("businessName", event.target.value)}
              {...errorProps("businessName")}
              required
            />
          </div>
          <Input
            label={t("md.phoneNumber")}
            disabled={pending}
            value={form.phoneNumber}
            onChange={(event) => set("phoneNumber", event.target.value)}
            {...errorProps("phoneNumber")}
            inputMode="tel"
          />
        </section>

        <section className="us-md-form-section" aria-labelledby="us-md-location-description">
          <h3 id="us-md-location-description">{t("md.addressKind")}</h3>
          <Select
            native
            label={t("md.addressKind")}
            disabled={pending}
            value={form.addressKind}
            onValueChange={(value) => set("addressKind", value)}
            options={[
              { value: "street", label: t("md.street") },
              { value: "coordinates", label: t("md.coordinates") },
            ]}
          />
          {form.addressKind === "street" ? (
            <Input
              label={t("md.streetAddress")}
              disabled={pending}
              value={form.streetAddress}
              onChange={(event) => set("streetAddress", event.target.value)}
              {...errorProps("streetAddress")}
            />
          ) : (
            <div className="us-md-form-grid">
              <Input
                label={t("md.latitude")}
                disabled={pending}
                value={form.latitude}
                onChange={(event) => set("latitude", event.target.value)}
                {...errorProps("latitude")}
                inputMode="decimal"
              />
              <Input
                label={t("md.longitude")}
                disabled={pending}
                value={form.longitude}
                onChange={(event) => set("longitude", event.target.value)}
                {...errorProps("longitude")}
                inputMode="decimal"
              />
            </div>
          )}
          <div className="us-md-form-grid us-md-form-grid--three">
            <Input
              label={t("md.city")}
              disabled={pending}
              value={form.city}
              onChange={(event) => set("city", event.target.value)}
              {...errorProps("city")}
            />
            <Input
              label={t("md.stateOrRegion")}
              disabled={pending}
              value={form.stateOrRegion}
              onChange={(event) => set("stateOrRegion", event.target.value)}
              {...errorProps("stateOrRegion")}
            />
            <Input
              label={t("md.zipOrPostalCode")}
              disabled={pending}
              value={form.zipOrPostalCode}
              onChange={(event) => set("zipOrPostalCode", event.target.value)}
              {...errorProps("zipOrPostalCode")}
              inputMode="text"
            />
          </div>
          <Input
            label={t("md.countryCode")}
            disabled={pending}
            value={form.countryCode}
            onChange={(event) => set("countryCode", event.target.value)}
            {...errorProps("countryCode")}
            hint={t("md.countryHint")}
            maxLength={2}
          />
        </section>

        <fieldset className="us-md-role-grid">
          <legend>{t("md.roles")}</legend>
          {locationRoles.map((role) => (
            <Checkbox
              key={role}
              label={t(`md.${roleKeys[role]}`)}
              disabled={pending}
              checked={form.roles.includes(role)}
              onCheckedChange={(checked) =>
                set(
                  "roles",
                  checked ? [...form.roles, role] : form.roles.filter((item) => item !== role),
                )
              }
            />
          ))}
        </fieldset>

        {selectedParentArchived ? (
          <div className="us-md-notice us-md-notice--alert" role="alert">
            {t(location || parent ? "md.parentArchivedSaveRestore" : "md.parentArchivedSaveChoose")}
          </div>
        ) : null}

        {gaps.length ? (
          <div className="us-md-readiness" role="status">
            <strong>{t("md.missingDescription")}</strong> {gaps.map(gapName).join(", ")}.
          </div>
        ) : (
          <div className="us-md-readiness us-md-readiness--complete" role="status">
            {t("md.complete")}
          </div>
        )}
      </form>
    </Drawer>
  );
}
