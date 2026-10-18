import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/office/list/list.css";
import "../../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { z } from "zod";
import { ThemeProvider } from "@markiro/ui";
import fixture from "../../../proto/fixtures/cloud-history-read.json";
import importSummary from "../../../proto/fixtures/cloud-import-summary.json";
import { createHostApi } from "../../../src/host/api.js";
import { HostError, type HostClient } from "../../../src/host/client.js";
import {
  cloudHistoryImportRequestSchema,
  cloudHistoryImportStateSchema,
  cloudHistoryManifestSchema,
  type CloudHistoryImportState,
} from "../../../src/host/cloud-history.js";
import { cloudPalletRowsSchema } from "../../../src/host/cloud-history-read.js";
import { shiftExportRowsSchema } from "../../../src/host/protocol.js";
import { exportFileBeginSchema, type ExportFile } from "../../../src/host/export-files.js";
import { Office } from "../../../src/office/Office.js";
import type { OfficeFilesApi } from "../../../src/office/exports/office-files.js";
import { ACTIVE_LICENSE } from "../../support/license.js";
import { HEALTHY_BACKUPS } from "../../support/backups.js";

// Controlled memory transport; actual Office, client schemas, renderer and stored-file checksum reader.
const request = cloudHistoryImportRequestSchema.parse(fixture.request);
const sourceZone = new URLSearchParams(location.search).has("unsupported-zone")
  ? "Mars/Base"
  : request.manifest.organization.timeZone;
const sources = fixture.exportSources.map((row) =>
  shiftExportRowsSchema.parse({
    ...row,
    organization: { ...row.organization, timeZone: sourceZone },
  }),
);
const pallets = fixture.palletSources.map((row) =>
  cloudPalletRowsSchema.parse({
    ...row,
    organization: { ...row.organization, timeZone: sourceZone },
  }),
);
let state: CloudHistoryImportState | null = null;
const stored = new Map<string, { file: ExportFile; contentBase64: string }>();
const metrics = {
  routes: [] as string[],
  replacements: [] as { dryRun: boolean; expectedRevision: number | null }[],
  formats: [] as string[],
  forms: [] as string[],
  downloads: 0,
  saved: 0,
  printed: 0,
};
declare global {
  interface Window {
    historyAcceptance: typeof metrics;
    historyUpload: string;
    historyRestart: () => void;
  }
}
window.historyAcceptance = metrics;
window.historyUpload =
  JSON.stringify(request.manifest) + "\n" + JSON.stringify(request.part) + "\n";
const user = {
  id: "11111111-0000-4000-8000-000000000001",
  login: "acceptance",
  name: "Контрольный администратор",
  role: "admin" as const,
};
const org = {
  name: "Changed standalone organization",
  inn: "7701234567",
  gln: request.manifest.organization.gln,
  gs1Prefixes: ["460068200"],
  timeZone: "America/New_York",
  rev: 1,
};
function notFound(): never {
  throw new HostError({
    kind: "api",
    code: "not_found",
    message: "controlled missing source",
    status: 404,
  });
}
function shiftCard(id: string) {
  const shift = request.part.payload.shifts.find((row) => row.id === id);
  if (!shift) return notFound();
  return {
    shift,
    sourceTimeZone: sourceZone,
    codeCount: request.part.payload.owners.filter((row) => row.shiftId === id).length,
    boxCount: request.part.payload.boxes.filter((row) => row.shiftId === id).length,
    palletCount: request.part.payload.pallets.filter((row) => row.shiftId === id).length,
    lateDataAt: null,
  };
}
function boxCard(id: string) {
  const pack = request.part.payload.boxes.find((row) => row.id === id);
  if (!pack) return notFound();
  const shift = shiftCard(pack.shiftId).shift;
  return {
    pack,
    sourceTimeZone: sourceZone,
    shiftNumber: shift.number,
    productName: shift.productName,
    productionDate: shift.productionDate,
    units: request.part.payload.items.filter((row) => row.boxId === id).length,
  };
}
const client: HostClient = {
  async request(method, path, options) {
    metrics.routes.push(`${method} ${path}`);
    const url = new URL(path, "http://fixture");
    const parts = url.pathname.split("/");
    const id = parts[4] ?? "";
    let answer: unknown;
    if (path === "/v1/office/org") answer = org;
    else if (path === "/v1/office/license") answer = ACTIVE_LICENSE;
    else if (path === "/v1/office/backups") answer = HEALTHY_BACKUPS;
    else if (path === "/v1/office/me") answer = user;
    else if (path === "/v1/office/import" && method === "POST") {
      const body = z
        .object({
          dryRun: z.boolean(),
          replacement: z.object({
            expectedRevision: z.number().optional(),
            history: cloudHistoryManifestSchema,
          }),
        })
        .parse(options.body);
      if (!body.dryRun && body.replacement.expectedRevision !== 42)
        throw new Error("controlled replacement revision differs");
      metrics.replacements.push({
        dryRun: body.dryRun,
        expectedRevision: body.replacement.expectedRevision ?? null,
      });
      const backupFile = "backups/pre-import/controlled-replacement.db";
      answer = {
        ...importSummary,
        dryRun: body.dryRun,
        replacement: {
          expectedRevision: 42,
          datasetEpoch: body.dryRun ? null : "550e8400-e29b-41d4-a716-446655440000",
          backupFile: body.dryRun ? null : backupFile,
        },
      };
      if (!body.dryRun)
        state = cloudHistoryImportStateSchema.parse({
          batchId: body.replacement.history.checksum,
          source: body.replacement.history.source,
          status: "pending",
          receivedIndices: [],
          totalParts: body.replacement.history.parts.length,
          counts: { shifts: 0, codes: 0, boxes: 0, items: 0, pallets: 0, owners: 0 },
          replacementBackupFile: backupFile,
        });
    } else if (path === "/v1/office/import/history" && method === "GET") answer = state;
    else if (path === "/v1/office/import/history" && method === "POST") {
      const body = cloudHistoryImportRequestSchema.parse(options.body);
      answer = cloudHistoryImportStateSchema.parse({
        batchId: body.manifest.checksum,
        source: body.manifest.source,
        status: state?.status ?? "pending",
        receivedIndices: [0],
        totalParts: 1,
        counts: body.manifest.counts,
        ...(state?.replacementBackupFile === undefined
          ? {}
          : { replacementBackupFile: state.replacementBackupFile }),
      });
      if (!body.dryRun) state = cloudHistoryImportStateSchema.parse(answer);
    } else if (path === "/v1/office/import/history/complete") {
      if (state === null) notFound();
      state = { ...state, status: "complete" };
      answer = state;
    } else if (path === "/v1/office/import/history/cancel") {
      state = null;
      answer = null;
    } else if (url.pathname === "/v1/office/cloud-shifts")
      answer = {
        items:
          state?.status === "complete"
            ? request.part.payload.shifts
                .filter((row) => row.inWindow)
                .map((row) => shiftCard(row.id))
            : [],
        total: request.part.payload.shifts.filter((row) => row.inWindow).length,
        page: 1,
        pageCount: 1,
      };
    else if (parts[3] === "cloud-shifts") {
      if (parts[5] === "export-source")
        answer = sources.find((row) => row.shift.id === id) ?? notFound();
      else if (parts[5] === "boxes")
        answer = request.part.payload.boxes
          .filter((row) => row.shiftId === id)
          .map((row) => boxCard(row.id));
      else if (parts[5] === "pallets") answer = pallets.filter((row) => row.pallet.shiftId === id);
      else answer = shiftCard(id);
    } else if (parts[3] === "cloud-boxes") {
      const box = boxCard(id);
      if (parts[5] === "report-data") {
        const codes = request.part.payload.codes;
        answer = {
          id,
          shiftId: box.pack.shiftId,
          sscc: box.pack.sscc,
          openedAt: box.pack.openedAt,
          closedAt: box.pack.closedAt,
          disassembledAt: box.pack.disassembledAt,
          productName: box.productName,
          organization: {
            name: request.manifest.organization.name,
            inn: request.manifest.organization.inn,
            timeZone: sourceZone,
          },
          items: request.part.payload.items
            .filter((row) => row.boxId === id)
            .map((item) => {
              const code = codes.find((row) => row.hash === item.hash);
              if (!code) throw new Error("fixture membership");
              return { gtin14: code.gtin14, serial: code.serial, canonical: code.canonical };
            }),
        };
      } else answer = box;
    } else if (parts[3] === "cloud-pallets" && parts[5] !== "exports")
      answer = pallets.find((row) => row.pallet.id === id) ?? notFound();
    else if (parts[5] === "exports") {
      answer = method === "GET" ? { items: [] } : null;
    } else if (url.pathname === "/v1/office/export-files" && method === "POST") {
      const body = exportFileBeginSchema.parse(options.body);
      if (body.contentBase64 === undefined)
        throw new Error("fixture only supports bounded single chunks");
      const file: ExportFile = {
        id: body.id,
        batchId: body.batchId,
        partNo: body.partNo,
        kind: body.kind,
        targetType: body.targetType,
        targetId: body.targetId,
        shiftId: body.targetType === "shift" ? body.targetId : null,
        formatId: body.formatId,
        formatVersion: body.formatVersion,
        fileName: body.fileName,
        mediaType: body.kind === "form" ? "text/html" : "application/octet-stream",
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        generator: body.generator,
        createdAt: new Date().toISOString(),
        userName: user.name,
      };
      stored.set(body.id, { file, contentBase64: body.contentBase64 });
      (body.kind === "form" ? metrics.forms : metrics.formats).push(body.formatId);
      answer = { id: body.id, chunkCount: 1, receivedChunks: 1, ready: true };
    } else if (url.pathname === "/v1/office/export-files")
      answer = {
        items: [...stored.values()]
          .map((row) => row.file)
          .filter((file) =>
            url.searchParams.has("targetId")
              ? file.targetId === url.searchParams.get("targetId")
              : file.shiftId === url.searchParams.get("shiftId"),
          ),
      };
    else if (parts[3] === "export-files" && parts[5] === "download") {
      const row = stored.get(id);
      if (!row) return notFound();
      metrics.downloads++;
      answer = { file: row.file, chunkCount: 1 };
    } else if (parts[3] === "export-files" && parts[5] === "chunks") {
      const row = stored.get(id);
      if (!row) return notFound();
      answer = { contentBase64: row.contentBase64 };
    } else if (url.pathname === "/v1/office/conflicts")
      answer = { items: [], total: 0, page: 1, pageCount: 1 };
    else if (
      ["shifts", "products", "lines", "templates", "counterparties"].includes(parts[3] ?? "")
    )
      answer = [];
    else if (parts[3] === "org" && parts[4] === "logo") answer = { logo: null };
    else return notFound();
    return options.schema.parse(answer);
  },
};
const api = createHostApi(client);
const files: OfficeFilesApi = {
  save: async (segments, rows) => {
    metrics.saved++;
    return {
      segments: [...segments],
      path: "Controlled memory output",
      files: rows.map((row) => row.name),
    };
  },
  open: async () => undefined,
  openFile: async () => undefined,
  pickFolder: async () => null,
  getExportsFolder: async () => ({ path: null, default: null }),
  setExportsFolder: async () => ({ path: null, default: null }),
};
const root = document.getElementById("root");
if (root === null) throw new Error("harness root");
const harnessRoot = createRoot(root);
let generation = 0;
function renderHarness() {
  harnessRoot.render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark">
        <Office
          key={generation}
          session={{
            user,
            api,
            call: (operation) => operation("controlled-fixture-session"),
            logout: async () => undefined,
            refreshUser: async () => undefined,
          }}
          files={files}
          printForm={() => {
            metrics.printed++;
          }}
          initialPath={new URLSearchParams(location.search).get("start") ?? "/import"}
        />
      </ThemeProvider>
    </StrictMode>,
  );
}
window.historyRestart = () => {
  generation++;
  renderHarness();
};
renderHarness();
