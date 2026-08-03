import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { Alert, Button, Card, Input, PageHeader, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import {
  useAvatarUrl,
  useDeleteAvatar,
  useProfile,
  useUpdateProfile,
  useUploadAvatar,
} from "./api.js";

export function ProfilePage() {
  const auth = useAuthClient();
  const session = auth.useSession();

  if (session.isPending) return <CenteredSpinner />;
  if (!session.data) return <Navigate to="/login" replace />;
  return <ProfileContent email={session.data.user.email} />;
}

function ProfileContent({ email }: { email: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const profile = useProfile();
  const avatar = useAvatarUrl(Boolean(profile.data?.hasAvatar));
  const update = useUpdateProfile();
  const upload = useUploadAvatar();
  const removeAvatar = useDeleteAvatar();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!profile.data || initialized.current) return;
    initialized.current = true;
    setFirstName(profile.data.firstName ?? "");
    setLastName(profile.data.lastName ?? "");
    setMiddleName(profile.data.middleName ?? "");
  }, [profile.data]);

  if (profile.isPending) return <CenteredSpinner />;
  if (profile.isError || !profile.data) {
    return (
      <div style={{ padding: 32 }}>
        <Alert tone="error">{t("profile.loadError")}</Alert>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaved(false);
    const normalizedFirstName = firstName.trim();
    const normalizedLastName = lastName.trim();
    if (!normalizedFirstName || !normalizedLastName) {
      setSaveError(t("profile.nameRequired"));
      return;
    }
    try {
      await update.mutateAsync({
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        middleName: middleName.trim() || null,
      });
      const requested = searchParams.get("returnTo");
      if (requested || searchParams.get("complete") === "1") {
        void navigate(safeReturnTo(requested), { replace: true });
      } else {
        setSaved(true);
      }
    } catch (caught) {
      setSaveError(caught instanceof ApiRequestError ? caught.message : t("profile.saveError"));
    }
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    setAvatarError(null);
    try {
      await upload.mutateAsync(file);
    } catch (caught) {
      setAvatarError(caught instanceof ApiRequestError ? caught.message : t("profile.avatarError"));
    }
  };

  const deleteAvatar = async () => {
    setAvatarError(null);
    try {
      await removeAvatar.mutateAsync();
    } catch (caught) {
      setAvatarError(caught instanceof ApiRequestError ? caught.message : t("profile.avatarError"));
    }
  };

  return (
    <main
      style={{
        maxWidth: 840,
        margin: "0 auto",
        padding: "36px 32px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <PageHeader title={t("profile.title")} />
      {searchParams.get("complete") === "1" ? (
        <Alert tone="info" title={t("profile.completeTitle")}>
          {t("profile.completeBody")}
        </Alert>
      ) : null}
      <Card title={t("profile.personalTitle")}>
        <form
          onSubmit={(event) => void submit(event)}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)",
            gap: 28,
          }}
        >
          <section
            style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}
          >
            {avatar.data?.url ? (
              <img
                src={avatar.data.url}
                alt={t("profile.avatarAlt")}
                width={144}
                height={144}
                style={{
                  width: 144,
                  height: 144,
                  objectFit: "cover",
                  borderRadius: "var(--r-3)",
                  border: "1px solid var(--line)",
                }}
              />
            ) : (
              <div
                aria-label={t("profile.noAvatar")}
                style={{
                  width: 144,
                  height: 144,
                  borderRadius: "var(--r-3)",
                  background: "var(--surface-panel)",
                  border: "1px solid var(--line)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--fg-3)",
                  font: "var(--text-body-sm)",
                  textAlign: "center",
                  padding: 12,
                  boxSizing: "border-box",
                }}
              >
                {t("profile.noAvatar")}
              </div>
            )}
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              label={t("profile.uploadAvatar")}
              disabled={upload.isPending}
              onChange={(event) => void uploadFile(event.target.files?.[0])}
            />
            {profile.data.hasAvatar ? (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                loading={removeAvatar.isPending}
                onClick={() => void deleteAvatar()}
              >
                {t("profile.deleteAvatar")}
              </Button>
            ) : null}
            {avatarError ? <Alert tone="error">{avatarError}</Alert> : null}
          </section>
          <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {saveError ? <Alert tone="error">{saveError}</Alert> : null}
            {saved ? <Alert tone="ok">{t("profile.saveSuccess")}</Alert> : null}
            <Input label={t("profile.email")} value={email} readOnly />
            <Input
              required
              autoComplete="given-name"
              label={t("profile.firstName")}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
            <Input
              required
              autoComplete="family-name"
              label={t("profile.lastName")}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
            <Input
              autoComplete="additional-name"
              label={t("profile.middleName")}
              value={middleName}
              onChange={(event) => setMiddleName(event.target.value)}
            />
            <Button type="submit" loading={update.isPending} style={{ alignSelf: "flex-start" }}>
              {t("profile.save")}
            </Button>
          </section>
        </form>
      </Card>
    </main>
  );
}

function CenteredSpinner() {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 96 }}>
      <Spinner label={t("common.loading")} />
    </div>
  );
}

function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/profile")
    ? value
    : "/";
}
