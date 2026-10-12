import { useId } from "react";
import { Input, Textarea } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { UsBrowserClient } from "../client.js";
import { RequestLotPicker } from "./lot-picker.js";
import { getRequestCopy } from "./copy.js";
import { parseRequestScope, requestScopeKeys, type RequestScopeFields } from "./scope.js";

export type RequestScopeEditorProps = {
  value: RequestScopeFields;
  disabled: boolean;
  onChange: (value: RequestScopeFields) => void;
  client: UsBrowserClient;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};
export function RequestScopeEditor({
  value,
  disabled,
  onChange,
  client,
  onForbidden,
  onSessionLost,
}: RequestScopeEditorProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const prefix = useId();
  const parsed = parseRequestScope(value);
  const nonempty = Object.values(value).some((field) => field !== "");
  const errors = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  return (
    <fieldset className="us-md-form" disabled={disabled}>
      <legend>{copy.scope}</legend>
      <p>{copy.scopeHelp}</p>
      {requestScopeKeys
        .filter((key) => key !== "lotId")
        .map((key) =>
          key === "tlcs" || key === "locationIds" ? (
            <div className="mk-field" key={key}>
              <label htmlFor={`${prefix}-${key}`}>{copy[key]}</label>
              <Textarea
                id={`${prefix}-${key}`}
                className="us-md-textarea"
                rows={4}
                value={value[key]}
                disabled={disabled}
                aria-invalid={errors.has(key) && nonempty}
                onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              />
              <p>{copy.listHelp}</p>
            </div>
          ) : (
            <Input
              key={key}
              label={copy[key]}
              value={value[key]}
              disabled={disabled}
              {...(errors.has(key) && nonempty ? { error: copy.scopeInvalid } : {})}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          ),
        )}
      <RequestLotPicker
        client={client}
        value={value.lotId}
        disabled={disabled}
        onChange={(id) => onChange({ ...value, lotId: id })}
        onForbidden={onForbidden}
        onSessionLost={onSessionLost}
      />
      <p>{copy.sourceReferenceHelp}</p>
      {!parsed.success && nonempty ? <p role="alert">{copy.scopeInvalid}</p> : null}
      <p>{copy.scopeEvidenceHelp}</p>
    </fieldset>
  );
}
