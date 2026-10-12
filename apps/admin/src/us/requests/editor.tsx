import { useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import type {
  UsRequestDetailResponse,
  UsTraceRequestCreateBody,
  UsTraceRequestUpdateBody,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import {
  canonicalRequestWall,
  changedRequestTiming,
  parseRequestTiming,
  requestTimingFields,
  type RequestTimingFields,
} from "./form.js";
import { resolveRequestWallTime } from "./time.js";
import { getRequestCopy, type RequestCopy } from "./copy.js";

export type RequestEditorProps = {
  detail: UsRequestDetailResponse | null;
  timeZone: string;
  disabled: boolean;
  onSave: (body: UsTraceRequestCreateBody | UsTraceRequestUpdateBody) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
};

export function RequestEditor({
  detail,
  timeZone,
  disabled,
  onSave,
  onDirtyChange,
}: RequestEditorProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const [baseline] = useState(detail);
  const [initial] = useState(() => requestTimingFields(detail, timeZone));
  const [fields, setFields] = useState(initial);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const owner = useRef(false);
  const alive = useRef(true);
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const update = <K extends keyof RequestTimingFields>(key: K, value: RequestTimingFields[K]) =>
    setFields((current) => ({ ...current, [key]: value }));
  const error = (key: string): { error: string } | Record<string, never> => {
    const code = errors[key];
    return code ? { error: copy[code as keyof RequestCopy] ?? copy.invalid } : {};
  };
  function timeInput(
    key: "receivedWall" | "dueWall",
    offset: "receivedOffsetSeconds" | "dueOffsetSeconds",
  ) {
    const result = resolveRequestWallTime(fields[key], timeZone);
    return (
      <>
        <Input
          type="datetime-local"
          step="0.001"
          label={copy[key]}
          value={fields[key]}
          disabled={disabled || pending}
          {...error(key)}
          onChange={(event) =>
            setFields((current) => ({
              ...current,
              [key]: canonicalRequestWall(event.target.value),
              [offset]: null,
            }))
          }
        />
        {result.kind === "fold" ? (
          <Select
            native
            label={copy[offset]}
            value={fields[offset] === null ? "" : String(fields[offset])}
            disabled={disabled || pending}
            onValueChange={(value) => update(offset, value === "" ? null : Number(value))}
            options={[
              { value: "", label: copy.chooseOffset },
              ...result.candidates.map((candidate) => ({
                value: String(candidate.offsetSeconds),
                label: `${copy.utcOffset} ${candidate.offsetSeconds / 3600}`,
              })),
            ]}
          />
        ) : null}
      </>
    );
  }
  return (
    <form
      className="us-md-form"
      aria-label={copy.requesterTab}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || owner.current) return;
        const parsed = parseRequestTiming(
          {
            ...fields,
            alternateDeadlineReason:
              fields.duePolicy === "default" ? "" : fields.alternateDeadlineReason,
          },
          timeZone,
        );
        if (!parsed.ok) {
          setErrors(parsed.fields);
          return;
        }
        const body = baseline
          ? changedRequestTiming(parsed.body, baseline)
          : { ...parsed.body, scope: null };
        if (baseline && Object.keys(body).length === 1) return;
        setErrors({});
        owner.current = true;
        setPending(true);
        void onSave(body)
          .catch(() => {
            /* Parent owns command outcomes; never expose raw errors. */
          })
          .finally(() => {
            owner.current = false;
            if (alive.current) setPending(false);
          });
      }}
    >
      <p>{copy.timingHelp}</p>
      <p>
        {copy.tenantTimeZone}: <span className="font-mono">{timeZone}</span>
      </p>
      {(
        ["requestNumber", "requesterName", "requesterOrganization", "requesterContact"] as const
      ).map((key) => (
        <Input
          key={key}
          label={copy[key]}
          value={fields[key]}
          disabled={disabled || pending}
          {...error(key)}
          onChange={(event) => update(key, event.target.value)}
        />
      ))}
      {timeInput("receivedWall", "receivedOffsetSeconds")}
      <Select
        native
        label={copy.deadlinePolicy}
        value={fields.duePolicy}
        disabled={disabled || pending}
        onValueChange={(value) => update("duePolicy", value)}
        options={[
          { value: "default", label: copy.defaultDeadline },
          { value: "alternative", label: copy.alternativeDeadline },
        ]}
      />
      {fields.duePolicy === "alternative" ? (
        <>
          {timeInput("dueWall", "dueOffsetSeconds")}
          <Input
            label={copy.alternateDeadlineReason}
            value={fields.alternateDeadlineReason}
            disabled={disabled || pending}
            {...error("alternateDeadlineReason")}
            onChange={(event) => update("alternateDeadlineReason", event.target.value)}
          />
        </>
      ) : (
        <p>{copy.defaultDeadline}</p>
      )}
      {!disabled ? (
        <Button type="submit" disabled={pending}>
          {copy.save}
        </Button>
      ) : null}
      {pending ? <p role="status">{copy.saving}</p> : null}
    </form>
  );
}
