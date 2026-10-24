import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  StandaloneReleaseChannel,
  StandaloneReleaseUpload,
} from "@markiro/platform-contracts";
import { Alert, Button, Card, DefinitionGrid, FileDropZone } from "@markiro/ui";

import {
  BucketUploadError,
  putToReleaseBucket,
  registerStandaloneRelease,
  requestStandaloneReleaseUpload,
} from "./api.js";
import {
  releaseErrorMessage,
  type ReleaseErrorMessage,
  type ReleaseOperation,
} from "./errorMessages.js";
import { readManifestFile, selectionIssues, type ManifestReading } from "./manifest.js";
import { formatByteCount, formatMegabytes, percentOf } from "./releaseFormat.js";
import { ReleaseError } from "./ReleaseError.js";

type Step = "preparing" | "manifest" | "installer" | "registering";

type Stage =
  | { kind: "idle" }
  | { kind: "working"; step: Step; manifest: number; installer: number }
  | {
      kind: "done";
      outcome: "registered" | "unchanged";
      channel: StandaloneReleaseChannel;
      version: string;
    }
  | { kind: "failed"; message: ReleaseErrorMessage };

const ACCEPT = ".jws,.exe";

/**
 * Upload of one signed release: the manifest and the installer go straight
 * into the release bucket by presigned PUTs, then the API verifies both and
 * registers the version. The panel signs nothing and trusts nothing it reads.
 */
export function ReleaseUpload({ onSettled }: { onSettled: () => void }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [manifest, setManifest] = useState<{ file: File; reading: ManifestReading } | null>(null);
  const [installer, setInstaller] = useState<File | null>(null);
  const [wrongFile, setWrongFile] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const attemptRef = useRef<{
    idempotencyKey: string;
    upload?: StandaloneReleaseUpload;
    manifestDone: boolean;
    installerDone: boolean;
  } | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const working = stage.kind === "working";
  const preview = manifest?.reading.ok ? manifest.reading.preview : null;
  const issues =
    preview && manifest
      ? selectionIssues(
          preview,
          manifest.file,
          installer ? { name: installer.name, size: installer.size } : null,
        )
      : [];
  // A finished attempt keeps its files on screen; another needs a fresh choice.
  const canPublish =
    preview !== null &&
    installer !== null &&
    !working &&
    stage.kind !== "done" &&
    issues.every((issue) => !issue.blocking);

  const choose = (file: File) => {
    attemptRef.current = null;
    setStage({ kind: "idle" });
    const name = file.name.toLowerCase();
    if (name.endsWith(".jws")) {
      setWrongFile(null);
      const sequence = ++readSequence.current;
      void readManifestFile(file).then((reading) => {
        if (sequence === readSequence.current) setManifest({ file, reading });
      });
    } else if (name.endsWith(".exe")) {
      setWrongFile(null);
      setInstaller(file);
    } else {
      setWrongFile(file.name);
    }
  };

  const reset = () => {
    attemptRef.current = null;
    readSequence.current += 1;
    setManifest(null);
    setInstaller(null);
    setWrongFile(null);
    setStage({ kind: "idle" });
  };

  const publish = async () => {
    if (!preview || !manifest || !installer) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const target = { channel: preview.channel, version: preview.version };
    const progress = (file: "manifest" | "installer") => (loaded: number, total: number) =>
      setStage((current) => {
        if (current.kind !== "working") return current;
        const percent = percentOf(loaded, total);
        return file === "manifest"
          ? { ...current, manifest: percent }
          : { ...current, installer: percent };
      });
    let operation: ReleaseOperation = "upload";
    setStage({ kind: "working", step: "preparing", manifest: 0, installer: 0 });
    try {
      const attempt = attemptRef.current ?? {
        idempotencyKey: crypto.randomUUID(),
        manifestDone: false,
        installerDone: false,
      };
      attemptRef.current = attempt;
      if (!attempt.upload) {
        const describe = async (file: File, max: number) => {
          if (file.size < 1 || file.size > max) throw new Error("Release file exceeds limit");
          const bytes = await file.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return {
            sizeBytes: file.size,
            sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
              "",
            ),
          };
        };
        const manifestDescriptor = await describe(manifest.file, 64 * 1024);
        const installerDescriptor = await describe(installer, 256 * 1024 * 1024);
        if (controller.signal.aborted) throw new BucketUploadError("aborted");
        attempt.upload = await requestStandaloneReleaseUpload({
          ...target,
          idempotencyKey: attempt.idempotencyKey,
          sourceSha: preview.sourceSha,
          manifest: manifestDescriptor,
          installer: installerDescriptor,
        });
      }
      const upload = attempt.upload;
      setStage({ kind: "working", step: "manifest", manifest: 0, installer: 0 });
      if (!attempt.manifestDone)
        await putToReleaseBucket({
          url: upload.manifest.uploadUrl,
          contentType: upload.manifest.contentType,
          file: manifest.file,
          signal: controller.signal,
          onProgress: progress("manifest"),
        });
      attempt.manifestDone = true;
      setStage({ kind: "working", step: "installer", manifest: 100, installer: 0 });
      if (!attempt.installerDone)
        await putToReleaseBucket({
          url: upload.installer.uploadUrl,
          contentType: upload.installer.contentType,
          file: installer,
          signal: controller.signal,
          onProgress: progress("installer"),
        });
      attempt.installerDone = true;
      operation = "register";
      setStage({ kind: "working", step: "registering", manifest: 100, installer: 100 });
      const result = await registerStandaloneRelease({ intentId: upload.intentId });
      setStage({ kind: "done", outcome: result.outcome, ...target });
    } catch (error) {
      setStage({
        kind: "failed",
        message: releaseErrorMessage(operation, error, { version: target.version }),
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      onSettled();
    }
  };

  return (
    <Card title={t("standaloneReleases.upload.title")} titleAs="h2" className="releases-card">
      <div className="releases-upload">
        <p className="releases-muted">{t("standaloneReleases.upload.hint")}</p>
        <FileDropZone
          label={t("standaloneReleases.upload.drop")}
          hint={t("standaloneReleases.upload.dropHint")}
          ariaLabel={t("standaloneReleases.upload.dropLabel")}
          accept={ACCEPT}
          multiple
          disabled={working}
          onFile={choose}
          onRejected={(file) => setWrongFile(file.name)}
        />
        {wrongFile !== null ? (
          <Alert tone="error" role="alert">
            {t("standaloneReleases.upload.wrongFile", { name: wrongFile })}
          </Alert>
        ) : null}
        {manifest && !manifest.reading.ok ? (
          <Alert tone="error" role="alert">
            {t(`standaloneReleases.upload.manifestProblems.${manifest.reading.problem}`)}
          </Alert>
        ) : null}
        {manifest || installer ? (
          <div
            role="group"
            aria-label={t("standaloneReleases.upload.selection")}
            className="releases-selection"
          >
            <DefinitionGrid
              items={[
                {
                  id: "channel",
                  term: t("standaloneReleases.upload.channel"),
                  description: preview ? t(`standaloneReleases.channel.${preview.channel}`) : "—",
                },
                {
                  id: "version",
                  term: t("standaloneReleases.upload.version"),
                  description: preview?.version ?? "—",
                  mono: true,
                },
                {
                  id: "manifest",
                  term: t("standaloneReleases.upload.manifest"),
                  description: manifest?.file.name ?? t("standaloneReleases.upload.notChosen"),
                },
                {
                  id: "installer",
                  term: t("standaloneReleases.upload.installer"),
                  description: installer
                    ? t("standaloneReleases.upload.fileWithSize", {
                        name: installer.name,
                        size: formatMegabytes(installer.size, language),
                      })
                    : t("standaloneReleases.upload.notChosen"),
                },
                {
                  id: "sha",
                  term: t("standaloneReleases.upload.expectedSha"),
                  description: preview ? (
                    <code className="releases-hash releases-hash--full">
                      {preview.installer.sha256}
                    </code>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
          </div>
        ) : null}
        {issues.map((issue) => (
          <Alert key={issue.kind} tone={issue.blocking ? "error" : "warn"}>
            {issue.kind === "installer_size"
              ? t("standaloneReleases.upload.issues.installer_size", {
                  actual: formatByteCount(issue.actual, language),
                  expected: formatByteCount(issue.expected, language),
                })
              : t(`standaloneReleases.upload.issues.${issue.kind}`, {
                  actual: issue.actual,
                  expected: issue.expected,
                })}
          </Alert>
        ))}
        {stage.kind === "working" ? (
          <div className="releases-progress">
            <p aria-live="polite">{t(`standaloneReleases.upload.steps.${stage.step}`)}</p>
            <ProgressRow label={t("standaloneReleases.upload.manifest")} value={stage.manifest} />
            <ProgressRow label={t("standaloneReleases.upload.installer")} value={stage.installer} />
          </div>
        ) : null}
        {stage.kind === "done" ? (
          <Alert tone="ok" role="status">
            {t(`standaloneReleases.upload.result.${stage.outcome}`, {
              version: stage.version,
              channel: t(`standaloneReleases.channel.${stage.channel}`),
            })}
          </Alert>
        ) : null}
        {stage.kind === "failed" ? <ReleaseError message={stage.message} /> : null}
        <div className="releases-actions">
          <Button disabled={!canPublish} onClick={() => void publish()}>
            {t("standaloneReleases.upload.submit")}
          </Button>
          {working && stage.step !== "registering" ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
              {t("standaloneReleases.upload.cancel")}
            </Button>
          ) : null}
          {!working && (manifest || installer) ? (
            <Button variant="ghost" onClick={reset}>
              {t("standaloneReleases.upload.reset")}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ProgressRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="releases-progress__row">
      <span>{label}</span>
      <progress max={100} value={value} aria-label={label} />
      <span className="releases-progress__value">{`${value} %`}</span>
    </div>
  );
}
