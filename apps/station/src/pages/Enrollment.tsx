import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Field, Input } from "@markiro/ui";
import { writeConfig } from "../lib/config.js";
import { createStationClient } from "../lib/api-client.js";

export interface EnrollmentProps {
  machineId: string;
  onEnrolled: () => void;
}

export function Enrollment({ machineId, onEnrolled }: EnrollmentProps) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const client = createStationClient({ machineId, apiKey, serverUrl });
      await client.whoami(); // 200 proves the key resolves a tenant
      await writeConfig({ machineId, apiKey, serverUrl });
      onEnrolled();
    } catch {
      setError(t("enroll.invalid"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Card style={{ minWidth: 480, padding: 32 }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("enroll.title")}</h1>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t("enroll.serverUrl")}>
          <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </Field>
        <Field label={t("enroll.apiKey")}>
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Button onClick={() => void submit()} disabled={busy || !serverUrl || !apiKey}>
          {t("enroll.submit")}
        </Button>
      </Card>
    </main>
  );
}
