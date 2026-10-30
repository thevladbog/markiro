import { palletCreationFailureKey } from "./pallet-creation-errors.js";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, Button, FileDropZone, Textarea } from "@markiro/ui";
import { HostError } from "../../host/client.js";
import { errorMessageKey } from "../../host/errors.js";
import {
  palletValidationSchema,
  type PalletValidation,
  type PalletCreated,
} from "../../host/office-pallet-create.js";
import { palletCreate, palletValidate } from "../../host/requests.js";
import { EntityDrawer } from "../EntityDrawer.js";
import { useOfficeMutation } from "../office-query.js";
import {
  inspectPalletInput,
  PalletInputError,
  parsePalletFile,
  PALLET_FILE_MAX_BYTES,
} from "./pallet-input.js";

export function CreatePalletDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (pallet: PalletCreated) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ text: string; result: PalletValidation } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [recovery, setRecovery] = useState<{ key: string; id: string } | null>(null);
  const generation = useRef(0);
  const fileGeneration = useRef(0);
  const running = useRef(false);
  const checking = useRef(false);
  const alive = useRef(true);
  const intent = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const validate = useOfficeMutation((api, token, codes: string[]) =>
    api.validateWarehousePallet(token, palletValidate(codes)),
  );
  const create = useOfficeMutation((api, token, request: ReturnType<typeof palletCreate>) =>
    api.createWarehousePallet(token, request),
  );
  const input = inspectPalletInput(text);
  const result = checked?.text === text ? checked.result : null;
  const ready =
    input.count > 0 &&
    !input.limitExceeded &&
    input.errors.length === 0 &&
    result?.valid === true &&
    result.errors.length === 0 &&
    !reading;
  const recoverable =
    recovery?.key === input.key &&
    input.count > 0 &&
    input.errors.length === 0 &&
    !input.limitExceeded &&
    !reading;
  const errors = attempted ? (result?.errors ?? input.errors) : [];
  function edit(value: string) {
    generation.current += 1;
    setText(value);
    setChecked(null);
    setAttempted(false);
    setFailure(null);
  }
  async function check() {
    if (checking.current || running.current || reading) return;
    setAttempted(true);
    setFailure(null);
    setChecked(null);
    if (input.count === 0 || input.limitExceeded || input.errors.length > 0) return;
    checking.current = true;
    const current = generation.current;
    try {
      const response = await validate.mutateAsync(input.codes);
      if (alive.current && current === generation.current) setChecked({ text, result: response });
    } catch (error) {
      if (alive.current && current === generation.current) setFailure(t(errorMessageKey(error)));
    } finally {
      checking.current = false;
    }
  }
  async function readFile(file: File) {
    const currentFile = ++fileGeneration.current;
    const current = generation.current;
    setReading(true);
    setChecked(null);
    setFailure(null);
    try {
      if (file.size > PALLET_FILE_MAX_BYTES) throw new PalletInputError("size");
      const codes = parsePalletFile(file.name, new Uint8Array(await file.arrayBuffer()));
      if (alive.current && current === generation.current && currentFile === fileGeneration.current)
        edit(codes.join("\n"));
    } catch (error) {
      if (alive.current && current === generation.current && currentFile === fileGeneration.current)
        setFailure(
          t(
            `office.createPallet.fileErrors.${error instanceof PalletInputError ? error.code : "read"}`,
          ),
        );
    } finally {
      if (alive.current && currentFile === fileGeneration.current) setReading(false);
    }
  }
  async function submit() {
    if ((!ready && !recoverable) || running.current || checking.current) return;
    running.current = true;
    setFailure(null);
    if (recoverable && recovery !== null) intent.current = recovery;
    else if (intent.current === null || intent.current.key !== input.key)
      intent.current = { key: input.key, id: crypto.randomUUID() };
    let saved: PalletCreated;
    try {
      saved = await create.mutateAsync(palletCreate(intent.current.id, input.codes));
    } catch (error) {
      if (!(error instanceof HostError) || error.kind === "transport") setRecovery(intent.current);
      if (
        error instanceof HostError &&
        error.code === "conflict" &&
        error.details.constraint === "pallet_codes"
      ) {
        const parsed = palletValidationSchema.safeParse(error.details.validation);
        if (parsed.success) {
          setChecked({ text, result: parsed.data });
          setAttempted(true);
        } else setFailure(t(errorMessageKey(error)));
      } else
        setFailure(
          t(
            error instanceof HostError && error.details.constraint === "request_id"
              ? "office.createPallet.requestConflict"
              : palletCreationFailureKey(error),
          ),
        );
      running.current = false;
      return;
    }
    running.current = false;
    onCreated(saved);
  }
  return (
    <EntityDrawer
      title={t("office.createPallet.title")}
      submitLabel={t(recoverable ? "office.createPallet.retry" : "office.createPallet.create")}
      submitDisabled={(!ready && !recoverable) || validate.isPending || reading}
      dirty={text.length > 0}
      onClose={() => {
        if (!running.current) onClose();
      }}
      onSubmit={submit}
      alert={failure === null ? null : <Alert tone="error">{failure}</Alert>}
    >
      <Textarea
        label={t("office.createPallet.codes")}
        value={text}
        rows={8}
        autoComplete="off"
        spellCheck={false}
        disabled={create.isPending}
        aria-describedby="pallet-input-hint"
        onChange={(event) => edit(event.target.value)}
      />
      <p id="pallet-input-hint" className="office-note">
        {t("office.createPallet.hint")}
      </p>
      <FileDropZone
        label={t("office.createPallet.fileDrop")}
        ariaLabel={t("office.createPallet.file")}
        hint={t("office.createPallet.replaceHint")}
        accept=".txt,.csv"
        disabled={create.isPending}
        busy={reading}
        busyLabel={t("office.createPallet.reading")}
        onFile={(file) => void readFile(file)}
        onRejected={(file) => void readFile(file)}
      />
      {recoverable && <Alert tone="warn">{t("office.createPallet.recoveryHint")}</Alert>}
      {reading && <p role="status">{t("office.createPallet.reading")}</p>}
      <Button
        variant="secondary"
        loading={validate.isPending}
        disabled={reading || create.isPending}
        onClick={() => void check()}
      >
        {t("office.createPallet.check")}
      </Button>
      {attempted && input.count === 0 && (
        <Alert tone="error">{t("office.createPallet.empty")}</Alert>
      )}
      {input.limitExceeded && <Alert tone="error">{t("office.createPallet.limit")}</Alert>}
      {errors.length > 0 && (
        <Alert tone="error">
          <p>{t("office.createPallet.fixAll")}</p>
          <ul>
            {errors.map((error, index) => (
              <li key={`${error.line}-${error.code}-${index}`}>
                {t("office.createPallet.lineError", {
                  line: error.line,
                  reason: t(`office.createPallet.errors.${error.code}`),
                })}
                {error.sscc !== null && ` — (00)${error.sscc}`}{" "}
                {error.palletId !== null && (
                  <Link
                    to={`/codes/${error.palletKind === "production" ? "pallet" : "warehouse-pallet"}/${error.palletId}`}
                  >
                    {t("office.createPallet.openPallet")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {result?.valid === true && (
        <Alert tone="ok">
          {t("office.createPallet.summary", {
            product: result.productName,
            boxes: result.boxes,
            units: result.units,
          })}
        </Alert>
      )}
    </EntityDrawer>
  );
}
