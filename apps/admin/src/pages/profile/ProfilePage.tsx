import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { Alert, Button, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import { AccountShell } from "../account/AccountShell.js";
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

  if (session.isPending) return <AccountLoading />;
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
  const avatarInputId = useId();
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

  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const handleBack = () => void navigate(returnTo);

  if (profile.isPending) {
    return (
      <AccountShell
        eyebrow={t("account.eyebrow")}
        title={t("profile.title")}
        description={t("profile.description")}
        accountLabel={email}
        backLabel={t("account.back")}
        onBack={handleBack}
      >
        <div className="mk-account-frame">
          <div
            className="mk-account-panel mk-account-profile-skeleton"
            role="status"
            aria-label={t("common.loading")}
          >
            <span />
            <span />
          </div>
        </div>
      </AccountShell>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <AccountShell
        eyebrow={t("account.eyebrow")}
        title={t("profile.title")}
        description={t("profile.description")}
        accountLabel={email}
        backLabel={t("account.back")}
        onBack={handleBack}
      >
        <div className="mk-account-frame">
          <div className="mk-account-panel mk-account-section">
            <Alert tone="error">{t("profile.loadError")}</Alert>
          </div>
        </div>
      </AccountShell>
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
      if (searchParams.get("returnTo") || searchParams.get("complete") === "1") {
        void navigate(returnTo, { replace: true });
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

  const initials = initialsOf(firstName, lastName, email);

  return (
    <AccountShell
      eyebrow={t("account.eyebrow")}
      title={t("profile.title")}
      description={t("profile.description")}
      accountLabel={email}
      backLabel={t("account.back")}
      onBack={handleBack}
    >
      {searchParams.get("complete") === "1" ? (
        <div className="mk-account-alert">
          <Alert tone="info" title={t("profile.completeTitle")}>
            {t("profile.completeBody")}
          </Alert>
        </div>
      ) : null}
      <div className="mk-account-frame">
        <div className="mk-account-panel">
          <form onSubmit={(event) => void submit(event)} className="mk-account-form">
            <section className="mk-account-section">
              <header className="mk-account-section__heading">
                <h2>{t("profile.photoTitle")}</h2>
                <p>{t("profile.photoHint")}</p>
              </header>
              <div className="mk-account-avatar-shell">
                {avatar.data?.url ? (
                  <img
                    className="mk-account-avatar"
                    src={avatar.data.url}
                    alt={t("profile.avatarAlt")}
                  />
                ) : (
                  <div className="mk-account-avatar__empty" aria-label={t("profile.noAvatar")}>
                    <span aria-hidden="true">{initials}</span>
                  </div>
                )}
              </div>
              <div className="mk-account-avatar-actions">
                <label
                  className="mk-account-upload"
                  data-disabled={upload.isPending || undefined}
                  htmlFor={avatarInputId}
                >
                  {profile.data.hasAvatar ? t("profile.changeAvatar") : t("profile.uploadAvatar")}
                  {/* eslint-disable-next-line no-restricted-syntax -- the browser file picker requires a native file input; the visible control is the associated styled label. */}
                  <input
                    className="mk-account-file-input"
                    id={avatarInputId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={t("profile.uploadAvatar")}
                    disabled={upload.isPending}
                    onChange={(event) => void uploadFile(event.target.files?.[0])}
                  />
                </label>
                {profile.data.hasAvatar ? (
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    fullWidth
                    loading={removeAvatar.isPending}
                    onClick={() => void deleteAvatar()}
                  >
                    {t("profile.deleteAvatar")}
                  </Button>
                ) : null}
                {avatarError ? <Alert tone="error">{avatarError}</Alert> : null}
              </div>
            </section>
            <section className="mk-account-section">
              <header className="mk-account-section__heading">
                <h2>{t("profile.personalTitle")}</h2>
                <p>{t("profile.personalHint")}</p>
              </header>
              <div className="mk-account-fields">
                {saveError || saved ? (
                  <div className="mk-account-fields__alerts">
                    {saveError ? <Alert tone="error">{saveError}</Alert> : null}
                    {saved ? <Alert tone="ok">{t("profile.saveSuccess")}</Alert> : null}
                  </div>
                ) : null}
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
                <div className="mk-account-form__actions">
                  <Button className="mk-account-action" type="submit" disabled={update.isPending}>
                    {t("profile.save")}
                    <span className="mk-account-action__icon" aria-hidden="true">
                      {update.isPending ? (
                        <span className="mk-account-org__progress">•••</span>
                      ) : (
                        <svg viewBox="0 0 20 20" focusable="false">
                          <path d="M4 10h11M10.5 5.5 15 10l-4.5 4.5" />
                        </svg>
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </section>
          </form>
        </div>
      </div>
    </AccountShell>
  );
}

function AccountLoading() {
  const { t } = useTranslation();
  return (
    <div className="mk-account-page">
      <div className="mk-account-page__loading" role="status" aria-label={t("common.loading")}>
        <span />
        <span />
      </div>
    </div>
  );
}

function initialsOf(firstName: string, lastName: string, email: string): string {
  const initials = `${firstName.trim()[0] ?? ""}${lastName.trim()[0] ?? ""}`.toUpperCase();
  return initials || email.trim().slice(0, 2).toUpperCase();
}

function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/profile")
    ? value
    : "/";
}
