import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal, RowActions, Select } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { OfficeShiftSets } from "../../host/protocol.js";
import { copyText } from "../info/clipboard.js";
import { useOfficeSession } from "../office-session.js";
import { searchableSelect } from "../select-search.js";
import { setIdentificationCode } from "../shifts/set-contents.js";
import { isAssembledSet, setExportRefusal } from "./export-source.js";
import "../shifts/set-contents.css";

export function SetClipboardDialog({
  shiftId,
  sets,
  onClose,
}: {
  shiftId: string;
  sets: OfficeShiftSets;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { api, call } = useOfficeSession();
  const [selectedId, setSelectedId] = useState(sets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const selected = sets.find(({ id }) => id === selectedId);
  const disabled = busy || blocked;

  async function copy(valueOf: (set: OfficeShiftSets[number]) => string | undefined) {
    if (selected === undefined || blocked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const [shift, freshSets] = await call((token) =>
        Promise.all([api.getShift(token, shiftId), api.listShiftSets(token, shiftId)]),
      );
      if (!alive.current) return;
      const refusal = setExportRefusal(shift.status, freshSets);
      if (refusal !== null) {
        setBlocked(true);
        setNotice({ ok: false, message: t(`office.exports.failures.${refusal}`) });
        return;
      }
      const fresh = freshSets.find((set) => set.id === selected.id && isAssembledSet(set));
      const value = fresh === undefined ? undefined : valueOf(fresh);
      if (value === undefined) {
        setBlocked(true);
        setNotice({ ok: false, message: t("office.exports.setCopy.unavailable") });
        return;
      }
      const ok = await copyText(value);
      if (alive.current) {
        setNotice({
          ok,
          message: t(ok ? "office.exports.setCopy.copied" : "office.exports.setCopy.copyFailed"),
        });
      }
    } catch (error) {
      if (alive.current) setNotice({ ok: false, message: t(errorMessageKey(error)) });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("office.exports.setCopy.title")}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("office.exports.setCopy.back")}
        </Button>
      }
    >
      <div className="office-stack" aria-busy={busy}>
        <p className="office-note">{t("office.exports.setCopy.hint")}</p>
        <Select
          label={t("office.exports.setCopy.choose")}
          value={selectedId}
          options={sets.map((set) => ({
            value: set.id,
            label: setIdentificationCode(set.setCode),
          }))}
          disabled={disabled}
          onValueChange={(id) => {
            setSelectedId(id);
            setNotice(null);
          }}
          {...searchableSelect(t)}
        />
        {selected !== undefined && (
          <>
            <code className="set-copy__parent">{setIdentificationCode(selected.setCode)}</code>
            <RowActions>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => void copy((set) => setIdentificationCode(set.setCode))}
              >
                {t("office.exports.setCopy.parent")}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => void copy((set) => set.items.map(setIdentificationCode).join("\n"))}
              >
                {t("office.exports.setCopy.items")}
              </Button>
            </RowActions>
            <ul className="set-copy__codes" aria-label={t("office.exports.setCopy.codes")}>
              {selected.items.map((item) => {
                const code = setIdentificationCode(item);
                return (
                  <li key={item.codeHash}>
                    <code>{code}</code>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={disabled}
                      aria-label={t("office.exports.setCopy.oneNamed", { code })}
                      onClick={() =>
                        void copy((set) => {
                          const freshItem = set.items.find(
                            (entry) => entry.codeHash === item.codeHash,
                          );
                          return freshItem === undefined
                            ? undefined
                            : setIdentificationCode(freshItem);
                        })
                      }
                    >
                      {t("office.exports.setCopy.one")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div aria-live="polite">
          {notice !== null && (
            <Alert role="presentation" tone={notice.ok ? "ok" : "warn"}>
              {notice.message}
            </Alert>
          )}
        </div>
      </div>
    </Modal>
  );
}
