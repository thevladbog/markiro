import { useCallback, useEffect, useRef, useState } from "react";
import {
  referenceDocumentInputSchema,
  type ReferenceDocumentInput,
  type ReferenceDocumentType,
} from "@markiro/platform-contracts";
import { Button, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { ReceivingReferencePicker } from "./reference-picker.js";

const DOCUMENT_TYPES: readonly ReferenceDocumentType[] = [
  "bol",
  "po",
  "asn",
  "work_order",
  "invoice",
  "database_record",
  "batch_log",
  "production_log",
  "other",
];

type MetadataDraft = {
  type: ReferenceDocumentType;
  typeOtherLabel: string;
  number: string;
  partyId: string;
  issuedOn: string;
  notes: string;
};

const EMPTY_METADATA: MetadataDraft = {
  type: "bol",
  typeOtherLabel: "",
  number: "",
  partyId: "",
  issuedOn: "",
  notes: "",
};

type Notice =
  | "attached"
  | "detached"
  | "duplicateAttachment"
  | "chooseDocument"
  | "attachmentLimit"
  | "invalidDocument"
  | "created"
  | "duplicateDocument"
  | "uncertainCreate"
  | "sessionLost"
  | "forbidden";

function isMetadataDirty(value: MetadataDraft): boolean {
  return (
    value.type !== EMPTY_METADATA.type ||
    value.typeOtherLabel !== "" ||
    value.number !== "" ||
    value.partyId !== "" ||
    value.issuedOn !== "" ||
    value.notes !== ""
  );
}

function parseMetadata(value: MetadataDraft) {
  return referenceDocumentInputSchema.safeParse({
    type: value.type,
    typeOtherLabel: value.type === "other" ? value.typeOtherLabel || null : null,
    number: value.number,
    partyId: value.partyId || null,
    issuedOn: value.issuedOn || null,
    notes: value.notes || null,
  });
}

export function ReceivingDocumentSection({
  client,
  documentIds,
  disabled,
  onChange,
  onSessionLost,
  onForbidden,
  beginMutation,
  onDirtyChange,
}: {
  client: UsBrowserClient;
  documentIds: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
  onSessionLost: () => void;
  onForbidden: () => Promise<void>;
  beginMutation: () => () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [candidateId, setCandidateId] = useState("");
  const [metadata, setMetadata] = useState<MetadataDraft>(EMPTY_METADATA);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [labelsFailed, setLabelsFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uncertainInput, setUncertainInput] = useState<ReferenceDocumentInput | null>(null);
  const labelsGeneration = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const documentIdsKey = documentIds.join(",");
  const atLimit = documentIds.length >= 100;
  const dirty = isMetadataDirty(metadata);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      dirtyCallback.current(false);
    };
  }, []);

  const loadAttachedLabels = useCallback(async () => {
    const current = ++labelsGeneration.current;
    setLabelsFailed(false);
    const attachedIds = documentIdsKey ? documentIdsKey.split(",") : [];
    const results = await Promise.allSettled(
      attachedIds.map(async (id) => ({
        id,
        label: (await client.getReferenceDocument(id)).number,
      })),
    );
    if (labelsGeneration.current !== current) return;
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    const clientErrors = errors.filter(
      (error): error is UsClientError => error instanceof UsClientError,
    );
    const auth =
      clientErrors.find((error) => error.code === "session_required") ??
      clientErrors.find((error) => error.code === "forbidden");
    if (auth?.code === "session_required") onSessionLost();
    if (auth?.code === "forbidden") await onForbidden();
    if (labelsGeneration.current !== current) return;
    const next: Record<string, string> = {};
    for (const result of results) {
      if (result.status === "fulfilled") next[result.value.id] = result.value.label;
    }
    setLabels(next);
    setLabelsFailed(errors.length > 0);
  }, [client, documentIdsKey, onForbidden, onSessionLost]);

  useEffect(() => {
    void loadAttachedLabels();
    return () => {
      labelsGeneration.current += 1;
    };
  }, [loadAttachedLabels]);

  function setField<K extends keyof MetadataDraft>(field: K, value: MetadataDraft[K]) {
    if (uncertainInput) return;
    setMetadata((current) => ({ ...current, [field]: value }));
    setNotice(null);
  }

  function attach() {
    if (disabled || pending) return;
    if (atLimit) {
      setNotice("attachmentLimit");
      return;
    }
    if (!candidateId) {
      setNotice("chooseDocument");
      return;
    }
    if (documentIds.includes(candidateId)) {
      setNotice("duplicateAttachment");
      return;
    }
    onChange([...documentIds, candidateId]);
    setCandidateId("");
    setNotice("attached");
  }

  function clearMetadata() {
    if (pending) return;
    setMetadata(EMPTY_METADATA);
    setUncertainInput(null);
    setNotice(null);
  }

  async function createAndAttach(input: ReferenceDocumentInput) {
    if (disabled || busy.current || atLimit) return;
    busy.current = true;
    const release = beginMutation();
    setPending(true);
    setNotice(null);
    try {
      const created = await client.createReferenceDocument(input);
      if (!alive.current) return;
      if (!documentIds.includes(created.id)) onChange([...documentIds, created.id]);
      setLabels((current) => ({ ...current, [created.id]: created.number }));
      setMetadata(EMPTY_METADATA);
      setUncertainInput(null);
      setNotice("created");
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        onSessionLost();
        if (!alive.current) return;
        setNotice("sessionLost");
      } else if (error instanceof UsClientError && error.code === "forbidden") {
        await onForbidden();
        if (!alive.current) return;
        setNotice("forbidden");
      } else if (error instanceof UsClientError && error.code === "document_duplicate") {
        setUncertainInput(null);
        setNotice("duplicateDocument");
      } else {
        setUncertainInput(input);
        setNotice("uncertainCreate");
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }

  function submitMetadata() {
    if (disabled || pending || atLimit || uncertainInput) return;
    const parsed = parseMetadata(metadata);
    if (!parsed.success) {
      setNotice("invalidDocument");
      return;
    }
    void createAndAttach(parsed.data);
  }

  const metadataDisabled = disabled || pending || uncertainInput !== null || atLimit;
  const noticeRole =
    notice === "attached" || notice === "detached" || notice === "created" ? "status" : "alert";

  return (
    <div className="us-receiving-documents">
      <p>{t("receivingRef.documentsIntro")}</p>
      {atLimit ? <p role="alert">{t("receivingRef.attachmentLimit")}</p> : null}
      {labelsFailed ? <p role="alert">{t("receivingRef.attachedLoadError")}</p> : null}
      <ul className="us-receiving-documents__attached">
        {documentIds.map((id) => (
          <li key={id}>
            <span>{labels[id] ?? t("receivingRef.selectedId", { id })}</span>{" "}
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={disabled || pending}
              aria-label={t("receivingRef.detach")}
              onClick={() => {
                onChange(documentIds.filter((current) => current !== id));
                setNotice("detached");
              }}
            >
              {t("receivingRef.detach")}
            </Button>
          </li>
        ))}
      </ul>
      {documentIds.length === 0 ? <p>{t("receivingRef.noDocuments")}</p> : null}

      <ReceivingReferencePicker
        client={client}
        kind="document"
        label={t("receivingRef.document")}
        value={candidateId}
        disabled={disabled || pending}
        onChange={setCandidateId}
        onSessionLost={onSessionLost}
        onForbidden={onForbidden}
      />
      <div className="us-receiving-documents__attach-action">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || pending || atLimit}
          onClick={attach}
        >
          {t("receivingRef.attach")}
        </Button>
      </div>

      <details
        className="us-receiving-documents__creator"
        onToggle={(event) => setCreatorOpen(event.currentTarget.open)}
      >
        <summary>{t("receivingRef.createTitle")}</summary>
        {creatorOpen ? (
          <div className="us-receiving-documents__creator-fields">
            <p>{t("receivingRef.createIntro")}</p>
            <Select
              native
              label={t("receivingRef.documentType")}
              value={metadata.type}
              disabled={metadataDisabled}
              onValueChange={(value) => setField("type", value)}
              options={DOCUMENT_TYPES.map((type) => ({
                value: type,
                label: t(`receivingRef.types.${type}`),
              }))}
            />
            {metadata.type === "other" ? (
              <Input
                label={t("receivingRef.typeOtherLabel")}
                value={metadata.typeOtherLabel}
                maxLength={200}
                disabled={metadataDisabled}
                onChange={(event) => setField("typeOtherLabel", event.target.value)}
              />
            ) : null}
            <Input
              label={t("receivingRef.documentNumber")}
              value={metadata.number}
              maxLength={128}
              disabled={metadataDisabled}
              onChange={(event) => setField("number", event.target.value)}
            />
            <ReceivingReferencePicker
              client={client}
              kind="party"
              label={t("receivingRef.issuingParty")}
              value={metadata.partyId}
              disabled={metadataDisabled}
              onChange={(value) => setField("partyId", value)}
              onSessionLost={onSessionLost}
              onForbidden={onForbidden}
            />
            <Input
              type="date"
              label={t("receivingRef.issuedOn")}
              value={metadata.issuedOn}
              disabled={metadataDisabled}
              onChange={(event) => setField("issuedOn", event.target.value)}
            />
            <Input
              label={t("receivingRef.notes")}
              value={metadata.notes}
              maxLength={2000}
              disabled={metadataDisabled}
              onChange={(event) => setField("notes", event.target.value)}
            />
            <div className="us-receiving-documents__creator-actions">
              {uncertainInput ? (
                <Button
                  type="button"
                  disabled={disabled || pending || atLimit}
                  loading={pending}
                  onClick={() => void createAndAttach(uncertainInput)}
                >
                  {t("receivingRef.retrySameCreate")}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={disabled || pending || atLimit}
                  loading={pending}
                  onClick={submitMetadata}
                >
                  {t("receivingRef.createAndAttach")}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={pending || !dirty}
                onClick={clearMetadata}
              >
                {t("receivingRef.clearCreate")}
              </Button>
            </div>
          </div>
        ) : null}
      </details>
      {notice ? <p role={noticeRole}>{t(`receivingRef.${notice}`)}</p> : null}
    </div>
  );
}
