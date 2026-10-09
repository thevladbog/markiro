import { useMemo, useState } from "react";
import {
  buildWarehouseCodeOnlyLabelTemplate,
  productLabelValueDigest,
  warehouseBoxTemplate,
  WAREHOUSE_REPRINT_PROTOCOL,
  warehousePreparedEvent,
} from "@markiro/domain";
import { WarehouseReprintView } from "../pages/WarehouseReprint.js";
import type { WarehouseWorkState } from "../lib/warehouse-reprint/work.js";
import { createCredentialGeneration } from "../lib/credential-recovery.js";
import type { StationClient } from "../lib/api-client.js";
const exec = { run: async () => {}, all: () => Promise.resolve([]) };
const client: StationClient = {
  get: () => Promise.reject(new Error("synthetic fixture")),
  post: () => Promise.reject(new Error("synthetic fixture")),
  download: () => Promise.resolve(new Blob()),
  whoami: () => Promise.resolve({ ok: true }),
};
const source = { start: () => () => {} };
export function WarehouseReprintGallery({ variant }: { variant: string }) {
  const seed = useMemo(() => {
    const box = warehouseBoxTemplate();
    const { digest, ...value } = {
      ...box,
      id: "00000000-0000-4000-8000-000000000040",
      name: "Только код",
      purpose: "product_duplicate" as const,
      spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    };
    void digest;
    const unit = { ...value, digest: productLabelValueDigest(value) };
    const event = warehousePreparedEvent();
    const state: WarehouseWorkState = {
      initialized: true,
      busy: variant === "lookup",
      catalog: {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([unit, box]),
        templates: [unit, box],
      },
      session: {
        owner: "synthetic",
        sessionId: event.sessionId,
        operatorId: event.operatorId,
        reason: "damaged",
        status: variant === "setup" ? "paused" : "active",
        unitTemplate: unit,
        boxTemplate: box,
        sentCount: variant === "legacy-sent" ? 1 : 0,
      },
      job:
        variant === "unknown" || variant === "legacy-sent"
          ? {
              jobId: event.jobId,
              attemptId: event.attemptId,
              attemptNo: 1,
              state: variant === "unknown" ? "delivery_unknown" : "sent",
              kind: "box",
              identity: event.identity,
              productName: "Сироп «Клюква», 0,5 л",
              templateName: box.name,
              printerName: "TSC 210",
              repair: event.repair,
              updatedAt: event.occurredAt,
            }
          : null,
      duplicate: false,
      error: null,
      verification: false,
      historyIssue: null,
    };
    return state;
  }, [variant]);
  const [state, setState] = useState(seed);
  const work = {
    scan: async () => {},
    newSession: async () => {},
    configure: (reason, unitTemplate, boxTemplate) => {
      setState((s) => ({
        ...s,
        session: s.session ? { ...s.session, reason, unitTemplate, boxTemplate } : null,
      }));
      return Promise.resolve();
    },
    start: () => {
      setState((s) => ({ ...s, session: s.session ? { ...s.session, status: "active" } : null }));
      return Promise.resolve();
    },
    close: async () => {},
    requestVerification: () => setState((s) => ({ ...s, verification: true })),
    cancelVerification: () => setState((s) => ({ ...s, verification: false })),
    reprint: async () => {},
    sendPrepared: async () => {},
  } satisfies Parameters<typeof WarehouseReprintView>[0]["work"];
  const generation = useMemo(() => createCredentialGeneration("synthetic-gallery-key"), []);
  return (
    <WarehouseReprintView
      exec={exec}
      client={client}
      deviceId="00000000-0000-4000-8000-000000000030"
      operatorId="00000000-0000-4000-8000-000000000001"
      credentialGeneration={generation}
      source={source}
      hardwareConfig={{
        scanner: null,
        printer: null,
        printerLanguage: "tspl",
        printerDpi: 203,
        verifyPrintedLabel: false,
      }}
      print={async () => {}}
      onExit={() => {}}
      state={state}
      work={work}
    />
  );
}
