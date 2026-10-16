import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  DefinitionGrid,
  FileDropZone,
  PageHeader,
  type DefinitionGridItem,
  type TableColumn,
} from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import { HostError } from "../../host/client.js";
import {
  cloudImportRequest,
  readCloudExportBlob,
  type CloudExportFile,
  type CloudFileProblem,
  type CloudImportSummary,
  type CutoverCounter,
} from "../../host/cloud-import.js";
import { errorMessageKey } from "../../host/errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { noteText } from "./import-notes.js";

/**
 * «Перенос из облака» (plan IMP, administrators): the cloud's file into this new site.
 *
 * The file holds PIN and badge hashes and the badge salt. It is read into a
 * ref (`HeldFile`) and nowhere else: not React state, not a query or a
 * mutation (react-query keeps a mutation's variables in its cache), not
 * storage, the URL or the console. What the page shows is `FileView`, made
 * once from the file: counts, notes in words, the SSCC table and the first
 * characters of the checksum, never a hash. The ref is emptied when the
 * import is done, when another file is chosen, when the file is taken away
 * and when the page closes. A refusal that can be fixed and retried (the
 * GLN, a lost answer) keeps it for the retry.
 */
export function CloudImportPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        title={t("office.cloudImport.title")}
        description={t("office.cloudImport.subtitle")}
      />
      <CloudImportContent />
    </>
  );
}

/** A confirmation press this soon after the dialog opened is a double click's second half. */
const PRESS_GUARD_MS = 400;

/** How many characters of the checksum the page shows. */
const CHECKSUM_PREFIX_LENGTH = 15;

/**
 * An export older than this is named with its age: the cut-over's file is
 * made after the cloud's freeze on the day itself, and an older one (a
 * rehearsal's, an aborted cut-over's) may start SSCC below serials the cloud
 * issued since.
 */
const STALE_EXPORT_MS = 12 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The file as read, held for one import: the only place its hashes live. */
interface HeldFile {
  file: CloudExportFile;
  /** One per file read: a repeat after a lost answer is the same import. */
  importId: string;
}

/** What the page shows of a file: nothing in it can sign anyone in. */
interface FileView {
  rehearsal: boolean;
  tenantName: string;
  exportedAt: string;
  /** Whole hours since the export when it is older than `STALE_EXPORT_MS`, else `null`. */
  staleHours: number | null;
  checksumPrefix: string;
  org: { name: string; inn: string | null; gln: string };
  counters: CutoverCounter[];
  shiftNumbers: string;
  notes: string[];
}

type PageProblem = CloudFileProblem | "shape" | "extension" | "unreadable";

function describeFile(t: TFunction, file: CloudExportFile, now: number): FileView {
  const age = now - Date.parse(file.exportedAt);
  return {
    rehearsal: file.rehearsal,
    tenantName: file.source.tenantName,
    exportedAt: file.exportedAt,
    staleHours: age > STALE_EXPORT_MS ? Math.floor(age / HOUR_MS) : null,
    checksumPrefix: file.checksum.slice(0, CHECKSUM_PREFIX_LENGTH),
    org: {
      name: file.payload.organization.name,
      inn: file.payload.organization.inn,
      gln: file.payload.organization.gln,
    },
    counters: file.cutover.ssccCounters,
    shiftNumbers: file.payload.shiftNumberCounters
      .map((each) => `${each.monthKey} → ${each.lastSeq}`)
      .join(", "),
    notes: file.notes.map((note) => noteText(t, note, file)),
  };
}

/** What `siteEntities` has words for. */
const SITE_ENTITIES: ReadonlySet<string> = new Set([
  "shifts",
  "sscc_blocks",
  "category_template_defaults",
  "products",
  "label_templates",
  "employees",
  "operators",
  "counterparties",
]);

/** The text of a refused import, in words, by its code and constraint. */
function failureText(t: TFunction, error: unknown): string {
  if (error instanceof HostError && error.kind === "api") {
    const details = error.details;
    const value = (key: string) => (typeof details[key] === "string" ? details[key] : "");
    if (error.code === "conflict" && details.constraint === "site_not_empty") {
      const entity = value("entity");
      return t("office.cloudImport.failure.siteNotEmpty", {
        entity: t(
          `office.cloudImport.siteEntities.${SITE_ENTITIES.has(entity) ? entity : "unknown"}`,
        ),
      });
    }
    if (error.code === "conflict" && details.constraint === "already_imported") {
      return t("office.cloudImport.failure.alreadyImported", { at: value("importedAt") });
    }
    if (error.code === "conflict" && details.constraint === "org_gln") {
      return t("office.cloudImport.failure.orgGln", {
        site: value("siteGln"),
        file: value("fileGln"),
      });
    }
    if (error.code === "validation_failed" && error.field !== null) {
      return t("office.cloudImport.failure.row", { field: error.field });
    }
  }
  return t(errorMessageKey(error));
}

function CloudImportContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // The call goes through `call` directly: `useOfficeMutation` would keep the
  // request, hashes and all, as the mutation's variables in the query client.
  const { api, call } = useOfficeSession();
  const org = useOfficeQuery(officeKeys.org, (host, token) => host.getOrg(token));
  const held = useRef<HeldFile | null>(null);
  // Counts the choices of a file, so a read that finishes after a newer choice is dropped.
  const generation = useRef(0);
  const pending = useRef(false);
  const doneRegion = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ kind: PageProblem; path?: string } | null>(null);
  const [view, setView] = useState<FileView | null>(null);
  const [trial, setTrial] = useState<CloudImportSummary | null>(null);
  const [done, setDone] = useState<CloudImportSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () => () => {
      // Leaving the page drops the file, and with it the answer of whatever is still on its way.
      generation.current += 1;
      held.current = null;
    },
    [],
  );

  // A finished import takes the focus: the buttons it was reached by are gone. A passive
  // effect, so it runs after the dialog's cleanup, which would give the focus back to a
  // button that is no longer there.
  useEffect(() => {
    if (done !== null) doneRegion.current?.focus();
  }, [done]);

  const forget = () => {
    generation.current += 1;
    held.current = null;
    setReading(false);
    setProblem(null);
    setView(null);
    setTrial(null);
    setDone(null);
    setFailure(null);
    setConfirming(false);
  };

  const choose = async (picked: File) => {
    forget();
    const mine = generation.current;
    setReading(true);
    let read;
    try {
      read = await readCloudExportBlob(picked);
    } catch {
      if (generation.current === mine) {
        setReading(false);
        setProblem({ kind: "unreadable" });
      }
      return;
    }
    // A later choice, taking the file away or leaving the page: this one is dropped unseen.
    if (generation.current !== mine) return;
    setReading(false);
    if (read.kind === "problem") {
      setProblem(
        read.problem === "format" && read.path !== undefined
          ? { kind: "shape", path: read.path }
          : { kind: read.problem },
      );
      return;
    }
    held.current = { file: read.file, importId: crypto.randomUUID() };
    setView(describeFile(t, read.file, Date.now()));
  };

  const run = async (dryRun: boolean): Promise<void> => {
    const mine = held.current;
    if (mine === null || pending.current) return;
    pending.current = true;
    setSending(true);
    setFailure(null);
    try {
      let summary: CloudImportSummary;
      try {
        summary = await call((token) =>
          api.importFromCloud(token, cloudImportRequest(mine.file, mine.importId, dryRun)),
        );
      } catch (error) {
        setFailure(failureText(t, error));
        return;
      }
      // The page was left or the file replaced while the host worked: nothing to show.
      if (held.current !== mine) return;
      if (dryRun && !summary.repeated) {
        setTrial(summary);
        return;
      }
      // Done (a check that finds the import already made is done too): the file is not needed again.
      held.current = null;
      setConfirming(false);
      setTrial(null);
      setDone(summary);
      // Every catalog and people list changed under the office's cache.
      void queryClient.resetQueries({ queryKey: ["office"] });
    } finally {
      pending.current = false;
      setSending(false);
    }
  };

  const siteGln = org.data?.gln ?? null;
  const counts = (summary: CloudImportSummary): DefinitionGridItem[] => [
    {
      id: "lines",
      term: t("office.cloudImport.counts.lines"),
      description: t("office.cloudImport.counts.linesValue", {
        created: summary.linesCreated,
        present: summary.linesPresent,
      }),
    },
    {
      id: "counterparties",
      term: t("office.cloudImport.counts.counterparties"),
      description: summary.counterparties,
    },
    {
      id: "templates",
      term: t("office.cloudImport.counts.templates"),
      description: t("office.cloudImport.counts.templatesValue", {
        templates: summary.templates,
        defaults: summary.orgDefaults + summary.categoryDefaults,
      }),
    },
    {
      id: "products",
      term: t("office.cloudImport.counts.products"),
      description: summary.products,
    },
    {
      id: "operators",
      term: t("office.cloudImport.counts.operators"),
      description: summary.operators,
    },
    { id: "badges", term: t("office.cloudImport.counts.badges"), description: summary.badges },
  ];
  const counterColumns: TableColumn<CutoverCounter>[] = [
    {
      key: "prefix",
      title: t("office.cloudImport.sscc.prefix"),
      mono: true,
      render: (row) => row.issuerPrefix,
    },
    {
      key: "kind",
      title: t("office.cloudImport.sscc.kind"),
      render: (row) => t(`office.cloudImport.kinds.${row.extension === 1 ? "pallet" : "box"}`),
    },
    {
      key: "owner",
      title: t("office.cloudImport.sscc.owner"),
      render: (row) =>
        row.owner.kind === "counterparty"
          ? t("office.cloudImport.sscc.counterparty", { name: row.owner.name })
          : t(`office.cloudImport.sscc.${row.owner.kind}`),
    },
    {
      key: "issued",
      title: t("office.cloudImport.sscc.issued"),
      mono: true,
      align: "right",
      render: (row) => (row.issuedMax === null ? t("office.common.none") : String(row.issuedMax)),
    },
    {
      key: "start",
      title: t("office.cloudImport.sscc.start"),
      mono: true,
      align: "right",
      render: (row) => String(row.standaloneStart),
    },
    {
      key: "cloud",
      title: t("office.cloudImport.sscc.cloud"),
      mono: true,
      align: "right",
      render: (row) =>
        row.cloudReseedTo === null
          ? t("office.cloudImport.sscc.noWindow")
          : String(row.cloudReseedTo),
    },
  ];

  return (
    <>
      <p className="office-note">{t("office.cloudImport.intro")}</p>
      <FileDropZone
        label={t("office.cloudImport.choose")}
        hint={t("office.cloudImport.chooseHint")}
        accept=".json,application/json"
        busy={reading}
        disabled={sending}
        onFile={(picked) => void choose(picked)}
        onRejected={() => {
          forget();
          setProblem({ kind: "extension" });
        }}
      />
      {problem !== null && (
        <Alert tone="error">
          {problem.kind === "shape"
            ? t("office.cloudImport.problems.shape", { path: problem.path })
            : t(`office.cloudImport.problems.${problem.kind}`)}
        </Alert>
      )}
      {view !== null && (
        <>
          {view.rehearsal && <Alert tone="warn">{t("office.cloudImport.rehearsal")}</Alert>}
          {view.staleHours !== null && (
            <Alert tone="warn">
              {t("office.cloudImport.staleExport", { hours: view.staleHours })}
            </Alert>
          )}
          <Card title={t("office.cloudImport.fileTitle")} titleAs="h2">
            <DefinitionGrid
              items={[
                {
                  id: "source",
                  term: t("office.cloudImport.source"),
                  description: view.tenantName,
                },
                {
                  id: "exportedAt",
                  term: t("office.cloudImport.exportedAt"),
                  description: view.exportedAt,
                  mono: true,
                },
                {
                  id: "checksum",
                  term: t("office.cloudImport.checksum"),
                  description: `${view.checksumPrefix}…`,
                  mono: true,
                },
                {
                  id: "org",
                  term: t("office.cloudImport.org"),
                  description: t("office.cloudImport.orgValue", {
                    name: view.org.name,
                    inn: view.org.inn ?? t("office.common.none"),
                    gln: view.org.gln,
                  }),
                },
              ]}
            />
            {siteGln !== null && siteGln !== view.org.gln && (
              <Alert tone="error">
                {t("office.cloudImport.glnMismatch", { site: siteGln, file: view.org.gln })}
              </Alert>
            )}
          </Card>
          <Card title={t("office.cloudImport.ssccTitle")} titleAs="h2">
            <p className="office-note">{t("office.cloudImport.ssccHint")}</p>
            <PagedTable
              tableId="cloud-import"
              columns={counterColumns}
              rows={view.counters}
              getRowKey={(row) => `${row.issuerPrefix}:${row.extension}`}
              empty={t("office.cloudImport.sscc.empty")}
            />
            <p className="office-note">
              {t("office.cloudImport.shiftNumbers", {
                months: view.shiftNumbers === "" ? t("office.common.none") : view.shiftNumbers,
              })}
            </p>
          </Card>
          <Card
            title={t("office.cloudImport.notesTitle", { count: view.notes.length })}
            titleAs="h2"
          >
            {view.notes.length === 0 ? (
              <p className="office-note">{t("office.cloudImport.noNotes")}</p>
            ) : (
              <ul>
                {view.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
          </Card>
          {failure !== null && !confirming && <Alert tone="error">{failure}</Alert>}
          {trial !== null && (
            <Card title={t("office.cloudImport.trialTitle")} titleAs="h2">
              <Alert tone="ok">{t("office.cloudImport.trialOk")}</Alert>
              <DefinitionGrid items={counts(trial)} />
            </Card>
          )}
          <div ref={doneRegion} tabIndex={-1}>
            {done !== null && (
              <Card title={t("office.cloudImport.doneTitle")} titleAs="h2">
                <Alert tone="ok">
                  {done.repeated
                    ? t("office.cloudImport.repeated")
                    : t("office.cloudImport.doneOk")}
                </Alert>
                <DefinitionGrid items={counts(done)} />
                <ul>
                  {view.rehearsal && <li>{t("office.cloudImport.afterRehearsal")}</li>}
                  <li>{t("office.cloudImport.afterStations")}</li>
                  <li>{t("office.cloudImport.afterDeleteFile")}</li>
                  <li>{t("office.cloudImport.afterCloudCounters")}</li>
                </ul>
              </Card>
            )}
          </div>
          {done === null && (
            <div className="standalone-form__actions">
              <Button variant="secondary" disabled={sending} onClick={forget}>
                {t("office.cloudImport.clear")}
              </Button>
              <Button variant="secondary" disabled={sending} onClick={() => void run(true)}>
                {t("office.cloudImport.check")}
              </Button>
              <Button
                disabled={sending || trial === null}
                onClick={() => {
                  setFailure(null);
                  setConfirming(true);
                }}
              >
                {t("office.cloudImport.import")}
              </Button>
            </div>
          )}
          {confirming && trial !== null && (
            <ConfirmImport
              trial={trial}
              rehearsal={view.rehearsal}
              failure={failure}
              onConfirm={() => run(false)}
              onClose={() => setConfirming(false)}
            />
          )}
        </>
      )}
    </>
  );
}

interface ConfirmImportProps {
  trial: CloudImportSummary;
  rehearsal: boolean;
  failure: string | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/**
 * The last question before the import: it names the counts and says it
 * cannot be undone. A rehearsal file asks once more: its box must be ticked
 * in this opening of the dialog, so a rehearsal file never lands on a
 * production site by a press of Enter.
 */
function ConfirmImport({ trial, rehearsal, failure, onConfirm, onClose }: ConfirmImportProps) {
  const { t } = useTranslation();
  const openedAt = useRef(performance.now());
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = rehearsal && !acknowledged;
  return (
    <FormDialog
      title={t("office.cloudImport.confirmTitle")}
      submitLabel={t("office.cloudImport.import")}
      submitDisabled={blocked}
      onSubmit={async () => {
        // Under the cursor of the double click that opened this dialog, the
        // submit button must not take that click's second half.
        if (performance.now() - openedAt.current < PRESS_GUARD_MS) return;
        // A submit that does not come from the button (Enter in the form) asks too.
        if (blocked) return;
        await onConfirm();
      }}
      onClose={onClose}
      alert={failure === null ? null : <Alert tone="error">{failure}</Alert>}
    >
      <p>
        {t("office.cloudImport.confirmText", {
          lines: trial.linesCreated,
          counterparties: trial.counterparties,
          templates: trial.templates,
          products: trial.products,
          operators: trial.operators,
          badges: trial.badges,
        })}
      </p>
      {rehearsal && (
        <>
          <p>{t("office.cloudImport.confirmRehearsal")}</p>
          <Checkbox
            label={t("office.cloudImport.confirmRehearsalCheck")}
            checked={acknowledged}
            onCheckedChange={setAcknowledged}
          />
        </>
      )}
    </FormDialog>
  );
}
