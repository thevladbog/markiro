import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { Alert, Button, Input, Spinner } from "@markiro/ui";
import { ApiRequestError } from "../../api/client.js";
import { AuthLayout } from "./AuthLayout.js";
import {
  completeTenantOwnerActivation,
  getTenantOwnerActivationStatus,
} from "./tenant-owner-activation-api.js";

export function ActivateOwnerPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("token")?.trim() ?? "";
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(!token);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void getTenantOwnerActivationStatus(token)
      .then((status) => {
        if (active) setHasAccount(status.hasAccount);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ApiRequestError && caught.status === 404) setUnavailable(true);
        else setError(t("auth.activateOwner.loadError"));
      });
    return () => {
      active = false;
    };
  }, [t, token]);

  if (unavailable) {
    return (
      <AuthLayout title={t("auth.activateOwner.invalidTitle")}>
        <Alert tone="error">{t("auth.activateOwner.invalidBody")}</Alert>
        <p style={{ marginTop: 16 }}>
          <Link to="/login">{t("auth.activateOwner.toLogin")}</Link>
        </p>
      </AuthLayout>
    );
  }
  if (hasAccount === null && !error) {
    return (
      <AuthLayout title={t("auth.activateOwner.title")}>
        <Spinner label={t("common.loading")} />
      </AuthLayout>
    );
  }

  const complete = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    if (!hasAccount && (password.length < 8 || password !== confirmation)) {
      setError(
        t(
          password !== confirmation
            ? "auth.activateOwner.mismatch"
            : "auth.activateOwner.passwordHint",
        ),
      );
      return;
    }
    setPending(true);
    try {
      await completeTenantOwnerActivation(token, hasAccount ? undefined : password);
      void navigate("/login", { replace: true });
    } catch {
      setError(t("auth.activateOwner.genericError"));
      setPending(false);
    }
  };

  return (
    <AuthLayout title={t("auth.activateOwner.title")}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {hasAccount ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Alert tone="info">{t("auth.activateOwner.existingAccountBody")}</Alert>
          <Button fullWidth loading={pending} onClick={() => void complete()}>
            {t("auth.activateOwner.confirm")}
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => void complete(event)}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <Input
            type="password"
            autoComplete="new-password"
            label={t("auth.activateOwner.passwordLabel")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            label={t("auth.activateOwner.confirmationLabel")}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <Button type="submit" loading={pending} fullWidth>
            {t("auth.activateOwner.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
