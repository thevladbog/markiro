import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  AdminPage,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  RadioGroup,
  Spinner,
  StatusChip,
} from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useLinePresence } from "../shifts/api.js";
import {
  useFixInventorySnapshot,
  useInventory,
  useStartInventory,
  useUploadInventoryImport,
} from "./api.js";
import { PreparationSteps } from "./PreparationSteps.js";
import {
  INVENTORY_CHZ_STATUSES,
  type InventoryChzStatus,
  type InventoryDetail,
  type InventoryImportHistory,
  type InventorySnapshot,
  type InventorySnapshotInputs,
} from "./schemas.js";
import "./inventory.css";

function latestSuccessfulImports(
  imports: InventoryImportHistory[],
): Partial<InventorySnapshotInputs> {
  const selected: Partial<InventorySnapshotInputs> = {};
  for (const status of INVENTORY_CHZ_STATUSES) {
    const attempt = imports.find(
      (item) => item.declaredStatus === status && item.result === "succeeded",
    );
    if (attempt) selected[status] = attempt.id;
  }
  return selected;
}

function completeSelection(
  selected: Partial<InventorySnapshotInputs>,
): selected is InventorySnapshotInputs {
  return INVENTORY_CHZ_STATUSES.every((status) => selected[status] !== undefined);
}

function count(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function InventoryDetailPage() {
  const { inventoryId = "" } = useParams();
  const { t } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const query = useInventory(inventoryId);
  const [step, setStep] = useState(2);
  const [selected, setSelected] = useState<Partial<InventorySnapshotInputs>>({});
  const [fixedSnapshot, setFixedSnapshot] = useState<InventorySnapshot | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setSelected((current) => {
      const defaults = latestSuccessfulImports(query.data.imports);
      const next = { ...current };
      for (const status of INVENTORY_CHZ_STATUSES) {
        const currentStillExists = query.data.imports.some(
          (attempt) => attempt.id === current[status] && attempt.result === "succeeded",
        );
        if (!currentStillExists && defaults[status]) next[status] = defaults[status];
      }
      return next;
    });
    if (query.data.activeSnapshot) {
      setFixedSnapshot(query.data.activeSnapshot);
      setStep((current) => (current < 4 ? 4 : current));
    }
  }, [query.data]);

  if (query.isPending) {
    return (
      <CenteredState>
        <Spinner label={t("common.loading")} />
      </CenteredState>
    );
  }
  if (query.isError || !query.data) {
    return (
      <AdminPage className="mk-inventory-page">
        <EmptyState
          title={t("pages.inventory.detail.loadError")}
          hint={t("pages.inventory.detail.loadErrorHint")}
          action={<Button onClick={() => void query.refetch()}>{t("common.retry")}</Button>}
        />
      </AdminPage>
    );
  }

  const inventory = query.data;
  const snapshot = fixedSnapshot ?? inventory.activeSnapshot;

  return (
    <AdminPage className="mk-inventory-page">
      <PageHeader
        title={inventory.number}
        actions={
          <StatusChip
            status={inventory.status === "running" ? "ok" : "neutral"}
            label={t(`pages.inventory.status.${inventory.status}`)}
          />
        }
      />
      <p className="mk-inventory-page__description">
        {inventory.productName} · {inventory.lineName} ·{" "}
        {t(`pages.inventory.mode.${inventory.mode}`)}
      </p>
      <PreparationSteps current={step} />
      {step === 2 ? (
        <ExportsStep
          inventory={inventory}
          canWrite={canWrite}
          selected={selected}
          onSelect={(status, id) => setSelected((current) => ({ ...current, [status]: id }))}
          onContinue={() => setStep(3)}
        />
      ) : null}
      {step === 3 ? (
        <SnapshotStep
          inventory={inventory}
          selected={selected}
          snapshot={snapshot}
          canWrite={canWrite}
          onBack={() => setStep(2)}
          onFixed={(value) => {
            setFixedSnapshot(value);
            setStep(4);
          }}
        />
      ) : null}
      {step === 4 && snapshot ? (
        <TerminalsStep
          inventory={inventory}
          snapshot={snapshot}
          onBack={() => setStep(3)}
          onContinue={() => setStep(5)}
        />
      ) : null}
      {step === 5 && snapshot ? (
        <LaunchStep
          inventory={inventory}
          snapshot={snapshot}
          canWrite={canWrite}
          onBack={() => setStep(4)}
        />
      ) : null}
      <p className="mk-inventory-note">{t("pages.inventory.create.inclusive")}</p>
      <Link className="mk-inventory-back-link" to="/inventory">
        {t("pages.inventory.detail.backToList")}
      </Link>
    </AdminPage>
  );
}

function CenteredState({ children }: { children: React.ReactNode }) {
  return <div className="mk-inventory-centered">{children}</div>;
}

function ExportsStep({
  inventory,
  canWrite,
  selected,
  onSelect,
  onContinue,
}: {
  inventory: InventoryDetail;
  canWrite: boolean;
  selected: Partial<InventorySnapshotInputs>;
  onSelect: (status: InventoryChzStatus, id: string) => void;
  onContinue: () => void;
}) {
  const { t, i18n } = useTranslation();
  const upload = useUploadInventoryImport();

  return (
    <Card title={t("pages.inventory.exports.title")} titleAs="h2">
      <p className="mk-inventory-section-description">{t("pages.inventory.exports.description")}</p>
      <div className="mk-inventory-upload-grid">
        {INVENTORY_CHZ_STATUSES.map((status) => {
          const attempts = inventory.imports.filter((attempt) => attempt.declaredStatus === status);
          return (
            <section
              className="mk-inventory-upload-slot"
              data-testid="inventory-upload-slot"
              id={`inventory-slot-${status}`}
              key={status}
            >
              <div className="mk-inventory-upload-slot__header">
                <span>
                  <strong>{t(`pages.inventory.chz.${status}`)}</strong>
                  <small>{status}</small>
                </span>
                {selected[status] ? (
                  <Badge tone="ok">{t("pages.inventory.exports.ready")}</Badge>
                ) : (
                  <Badge>{t("pages.inventory.exports.missing")}</Badge>
                )}
              </div>
              {canWrite ? (
                <Input
                  className="mk-inventory-file-control"
                  label={t("pages.inventory.exports.chooseFile")}
                  type="file"
                  accept=".csv,.zip,.xlsx"
                  aria-label={t("pages.inventory.exports.fileLabel", { status })}
                  disabled={upload.isPending}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) upload.mutate({ inventoryId: inventory.id, status, file });
                    event.currentTarget.value = "";
                  }}
                />
              ) : null}
              {attempts.length === 0 ? (
                <small>{t("pages.inventory.exports.noAttempts")}</small>
              ) : (
                <RadioGroup
                  className="mk-inventory-import-history"
                  aria-label={t("pages.inventory.exports.selectFile", { status })}
                  value={selected[status] ?? ""}
                  onValueChange={(id) => onSelect(status, id)}
                  options={attempts.map((attempt) => ({
                    value: attempt.id,
                    disabled: attempt.result !== "succeeded",
                    label: <ImportAttemptLabel attempt={attempt} locale={i18n.language} />,
                  }))}
                />
              )}
            </section>
          );
        })}
      </div>
      {upload.isError ? <Alert tone="error">{upload.error.message}</Alert> : null}
      <div className="mk-inventory-actions">
        <Button type="button" disabled={!completeSelection(selected)} onClick={onContinue}>
          {t("pages.inventory.exports.review")}
        </Button>
      </div>
    </Card>
  );
}

function ImportAttemptLabel({
  attempt,
  locale,
}: {
  attempt: InventoryImportHistory;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <span className="mk-inventory-import-attempt">
      <strong>{attempt.fileName}</strong>
      <small>
        {count(attempt.rowCount, locale)} ·{" "}
        {t("pages.inventory.exports.errors", { count: attempt.errorCount })} ·{" "}
        {t("pages.inventory.exports.duplicates", { count: attempt.duplicateCount })}
      </small>
      {attempt.diagnostics.map((diagnostic) => (
        <small
          className="mk-inventory-error"
          key={`${diagnostic.code}-${diagnostic.rowNumber ?? ""}`}
        >
          {diagnostic.code}
          {diagnostic.rowNumber ? ` · ${diagnostic.rowNumber}` : ""}
        </small>
      ))}
    </span>
  );
}

function SnapshotStep({
  inventory,
  selected,
  snapshot,
  canWrite,
  onBack,
  onFixed,
}: {
  inventory: InventoryDetail;
  selected: Partial<InventorySnapshotInputs>;
  snapshot: InventorySnapshot | null;
  canWrite: boolean;
  onBack: () => void;
  onFixed: (snapshot: InventorySnapshot) => void;
}) {
  const { t, i18n } = useTranslation();
  const fix = useFixInventorySnapshot();
  const introduced = inventory.imports.find((attempt) => attempt.id === selected.INTRODUCED);

  return (
    <Card title={t("pages.inventory.snapshot.title")} titleAs="h2">
      <p className="mk-inventory-section-description">
        {t("pages.inventory.snapshot.description")}
      </p>
      <div className="mk-inventory-metrics">
        <Metric label="INTRODUCED" value={count(introduced?.rowCount ?? 0, i18n.language)} />
        <Metric
          label={t("pages.inventory.snapshot.files")}
          value={`${Object.keys(selected).length} / 6`}
        />
        <Metric
          label={t("pages.inventory.snapshot.expectedLabel")}
          value={snapshot ? count(snapshot.counts.expected, i18n.language) : "—"}
          tone="accent"
        />
      </div>
      {snapshot ? (
        <Alert tone="ok">
          {t("pages.inventory.snapshot.expected", {
            count: count(snapshot.counts.expected, i18n.language),
          })}
        </Alert>
      ) : (
        <Alert tone="info">{t("pages.inventory.snapshot.fixHint")}</Alert>
      )}
      {fix.isError ? <Alert tone="error">{fix.error.message}</Alert> : null}
      <div className="mk-inventory-actions">
        <Button variant="secondary" type="button" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button
          type="button"
          disabled={!canWrite || !completeSelection(selected) || snapshot !== null}
          loading={fix.isPending}
          onClick={() => {
            if (!completeSelection(selected)) return;
            fix.mutate({ inventoryId: inventory.id, imports: selected }, { onSuccess: onFixed });
          }}
        >
          {t("pages.inventory.snapshot.fix")}
        </Button>
      </div>
    </Card>
  );
}

function TerminalsStep({
  inventory,
  snapshot,
  onBack,
  onContinue,
}: {
  inventory: InventoryDetail;
  snapshot: InventorySnapshot;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t, i18n } = useTranslation();
  const presence = useLinePresence();
  const line = presence.data?.find((item) => item.lineId === inventory.lineId);
  return (
    <Card title={t("pages.inventory.terminals.title")} titleAs="h2">
      <p className="mk-inventory-section-description">
        {t("pages.inventory.terminals.description")}
      </p>
      {presence.isPending ? <Spinner label={t("common.loading")} /> : null}
      {presence.isError ? (
        <Alert tone="error">{t("pages.inventory.terminals.loadError")}</Alert>
      ) : null}
      {line ? (
        <div className="mk-inventory-terminal-line">
          <span>
            <strong>{line.lineName}</strong>
            <small>
              {t("pages.inventory.terminals.assigned", { count: line.assignedStations })}
            </small>
          </span>
          <StatusChip
            status={line.onlineStations > 0 ? "ok" : "neutral"}
            label={t("pages.inventory.terminals.online", {
              online: line.onlineStations,
              total: line.assignedStations,
            })}
          />
        </div>
      ) : null}
      <Alert tone="info">
        {t("pages.inventory.snapshot.expected", {
          count: count(snapshot.counts.expected, i18n.language),
        })}
      </Alert>
      <div className="mk-inventory-task-form">
        <strong>{t("pages.inventory.terminals.formTitle")}</strong>
        <p>{t("pages.inventory.terminals.formUnavailable")}</p>
        <Button type="button" variant="secondary" disabled>
          {t("pages.inventory.terminals.downloadPdf")}
        </Button>
      </div>
      <div className="mk-inventory-actions">
        <Button variant="secondary" type="button" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button type="button" onClick={onContinue}>
          {t("pages.inventory.terminals.next")}
        </Button>
      </div>
    </Card>
  );
}

function LaunchStep({
  inventory,
  snapshot,
  canWrite,
  onBack,
}: {
  inventory: InventoryDetail;
  snapshot: InventorySnapshot;
  canWrite: boolean;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const start = useStartInventory();
  const [warehouseStopped, setWarehouseStopped] = useState(false);

  return (
    <Card title={t("pages.inventory.launch.title")} titleAs="h2">
      <Alert tone="ok">
        {t("pages.inventory.launch.snapshotReady", {
          count: count(snapshot.counts.expected, i18n.language),
        })}
      </Alert>
      <dl className="mk-inventory-summary">
        <div>
          <dt>{t("pages.inventory.create.product")}</dt>
          <dd>{inventory.productName}</dd>
        </div>
        <div>
          <dt>{t("pages.inventory.create.line")}</dt>
          <dd>{inventory.lineName}</dd>
        </div>
        <div>
          <dt>{t("pages.inventory.create.mode")}</dt>
          <dd>{t(`pages.inventory.mode.${inventory.mode}`)}</dd>
        </div>
      </dl>
      <Checkbox
        label={t("pages.inventory.launch.warehouseStopped")}
        checked={warehouseStopped}
        onCheckedChange={setWarehouseStopped}
        disabled={!canWrite || start.isPending}
      />
      {!warehouseStopped ? <Alert tone="warn">{t("pages.inventory.launch.blocked")}</Alert> : null}
      {start.isError ? <Alert tone="error">{start.error.message}</Alert> : null}
      <div className="mk-inventory-actions">
        <Button variant="secondary" type="button" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button
          type="button"
          disabled={!canWrite || !warehouseStopped}
          loading={start.isPending}
          onClick={() => start.mutate(inventory.id)}
        >
          {t("pages.inventory.launch.start")}
        </Button>
      </div>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "accent" }) {
  return (
    <div
      className={tone ? "mk-inventory-metric mk-inventory-metric--accent" : "mk-inventory-metric"}
    >
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
