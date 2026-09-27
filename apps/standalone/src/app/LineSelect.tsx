import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import { DeviceError, type DeviceErrorCode } from "../host/device.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { HostStatusLine } from "./HostStatusLine.js";
import type { SyncState } from "./shell.js";

const lineRow = z.object({ id: z.string(), name: z.string() });
type Line = z.infer<typeof lineRow>;

/**
 * `errors.device.<code>`, except `unreachable`: a station can reach this
 * screen already paired with a host elsewhere on the network, so the text
 * must not claim the unreachable host is this computer's own service.
 * `NetworkPairing.failureKey` handles the same code the same way.
 */
function failureKey(code: DeviceErrorCode): string {
  return code === "unreachable" ? "errors.link.unreachable" : `errors.device.${code}`;
}

/** «Линия 2» before «Линия 10». */
const BY_NAME = new Intl.Collator("ru", { numeric: true });

export interface LineSelectProps {
  local: LocalExecutor;
  sync: SyncState;
  link: HostStatus | null;
  /** Chooses the line with the host; rejects with a `DeviceError` the screen explains. */
  onSelect: (lineId: string) => Promise<void>;
  /** Asks for a reference sync now. */
  onSync: () => void;
  onOffice: () => void;
}

/**
 * A paired station chooses its line (spec §5.1) among the active lines of
 * the local copies. They are read only once a sync in this session brought
 * them up to date, and again after every sync, so a previous pairing's lines
 * never show.
 */
export function LineSelect({ local, sync, link, onSelect, onSync, onOffice }: LineSelectProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [failure, setFailure] = useState<DeviceErrorCode | null>(null);

  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    local.query("SELECT id, name FROM ref_lines WHERE archived = 0", [], lineRow).then(
      (rows) => {
        if (cancelled) return;
        setLines([...rows].sort((a, b) => BY_NAME.compare(a.name, b.name)));
        setReadFailed(false);
      },
      () => {
        if (!cancelled) setReadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, sync.synced]);

  const choose = async (lineId: string) => {
    setChoosing(lineId);
    setFailure(null);
    try {
      // On success the shell leaves this screen.
      await onSelect(lineId);
    } catch (error) {
      const code = error instanceof DeviceError ? error.code : "request_failed";
      setFailure(code);
      setChoosing(null);
      // The line was archived or deleted meanwhile: sync, then read the lines again.
      if (code === "line_rejected") onSync();
    }
  };

  const content = () => {
    if (lines === null) {
      if (sync.kind === "failed" || readFailed) {
        return (
          <Alert
            tone="error"
            action={
              <Button variant="secondary" size="compact" onClick={onSync}>
                {t("shell.lineSelect.retry")}
              </Button>
            }
          >
            {t("shell.lineSelect.syncFailed")}
          </Alert>
        );
      }
      return (
        <div className="standalone-probing">
          <Spinner size={32} />
          <p>{t("shell.lineSelect.loading")}</p>
        </div>
      );
    }
    if (lines.length === 0) return <p>{t("shell.lineSelect.empty")}</p>;
    return (
      <div className="line-select">
        {lines.map((line) => (
          <Button
            key={line.id}
            variant="secondary"
            size="floor"
            fullWidth
            loading={choosing === line.id}
            disabled={choosing !== null && choosing !== line.id}
            onClick={() => void choose(line.id)}
          >
            {line.name}
          </Button>
        ))}
      </div>
    );
  };

  return (
    <Card className="standalone-card" title={t("shell.lineSelect.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("shell.lineSelect.body")}</p>
        {failure && <Alert tone="error">{t(failureKey(failure))}</Alert>}
        {content()}
        <HostStatusLine status={link} />
        <div className="standalone-form__actions">
          <Button variant="secondary" onClick={onOffice}>
            {t("floor.office")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
