import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";

import { Alert, Button, Card, Input, Spinner, StatusChip } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import {
  acceptInvitation,
  registerInvitation,
  rejectInvitation,
  useInvitation,
  type PublicInvitation,
} from "./api.js";

type TerminalState = "accepted" | "rejected";

export function InvitationPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const invitation = useInvitation(id);
  const [terminal, setTerminal] = useState<TerminalState | null>(null);

  if (
    !id ||
    (invitation.isError &&
      invitation.error instanceof ApiRequestError &&
      invitation.error.status === 404)
  ) {
    return (
      <InvitationFrame>
        <State title={t("invitation.unavailableTitle")} body={t("invitation.unavailableBody")} />
      </InvitationFrame>
    );
  }
  if (invitation.isError) {
    const rateLimited =
      invitation.error instanceof ApiRequestError && invitation.error.status === 429;
    return (
      <InvitationFrame>
        <State
          title={t(rateLimited ? "invitation.rateLimitTitle" : "invitation.loadErrorTitle")}
          body={t(rateLimited ? "invitation.rateLimitBody" : "invitation.loadErrorBody")}
          action={
            <Button variant="secondary" onClick={() => void invitation.refetch()}>
              {t("invitation.retry")}
            </Button>
          }
        />
      </InvitationFrame>
    );
  }
  if (invitation.isPending || !invitation.data) {
    return (
      <InvitationFrame>
        <div style={{ display: "flex", justifyContent: "center", padding: 36 }}>
          <Spinner label={t("common.loading")} />
        </div>
      </InvitationFrame>
    );
  }
  if (terminal) {
    return (
      <InvitationFrame>
        <State
          title={t(`invitation.${terminal}Title`)}
          body={t(`invitation.${terminal}Body`)}
          action={<Link to="/">{t("invitation.toCabinet")}</Link>}
        />
      </InvitationFrame>
    );
  }

  return (
    <InvitationFrame>
      <InvitationSummary invitation={invitation.data} />
      {invitation.data.hasAccount ? (
        <ExistingAccount invitation={invitation.data} onTerminal={setTerminal} />
      ) : (
        <Registration invitation={invitation.data} />
      )}
    </InvitationFrame>
  );
}

function InvitationFrame({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "72px 24px",
        background: "var(--surface-page)",
      }}
    >
      <Card style={{ width: 440, maxWidth: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{children}</div>
      </Card>
    </main>
  );
}

function InvitationSummary({ invitation }: { invitation: PublicInvitation }) {
  const { t } = useTranslation();
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <StatusChip
        status="info"
        label={t("invitation.pending")}
        style={{ alignSelf: "flex-start" }}
      />
      <h1 style={{ margin: 0, font: "var(--text-h1)", color: "var(--fg-1)" }}>
        {t("invitation.title")}
      </h1>
      <p style={{ margin: 0, font: "var(--text-body)", color: "var(--fg-2)" }}>
        {t("invitation.summary", {
          organization: invitation.organizationName,
          role: t(`pages.team.roles.${invitation.role}`, { defaultValue: invitation.role }),
        })}
      </p>
    </header>
  );
}

function Registration({ invitation }: { invitation: PublicInvitation }) {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const session = auth.useSession();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    let registeredThisAttempt = false;
    const normalizedFirstName = firstName.trim();
    const normalizedLastName = lastName.trim();
    if (!registered && (!normalizedFirstName || !normalizedLastName)) {
      setError(t("invitation.nameRequired"));
      setPending(false);
      return;
    }
    try {
      if (!registered) {
        await registerInvitation(invitation.id, {
          firstName: normalizedFirstName,
          lastName: normalizedLastName,
          middleName: middleName.trim() || null,
          password,
        });
        setRegistered(true);
        registeredThisAttempt = true;
      }
      await acceptInvitation(invitation.id);
    } catch (caught) {
      // Registration establishes the session cookie. If accepting fails, refresh
      // the shared auth atom only after that failure; the remounted invitation
      // route then derives the account state from the server instead of relying
      // on this component's local `registered` flag.
      if (registeredThisAttempt) {
        try {
          await session.refetch?.();
        } catch {
          // The acceptance error remains the actionable message. A later route
          // load can still discover the cookie-backed session.
        }
      }
      setError(caught instanceof ApiRequestError ? caught.message : t("invitation.genericError"));
      setPending(false);
      return;
    }

    // Accept while this anonymous route is still mounted, then refresh identity.
    // AuthQueryBoundary intentionally remounts on that refresh, so navigate using
    // the stable router callback rather than storing success in component state.
    try {
      await session.refetch?.();
    } catch {
      // Acceptance already succeeded server-side; let the destination route
      // perform its normal session discovery instead of trapping the user here.
    }
    void navigate("/", { replace: true });
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Input label={t("invitation.email")} value={invitation.email} readOnly />
      <Input
        required
        autoComplete="given-name"
        label={t("invitation.firstName")}
        value={firstName}
        onChange={(event) => setFirstName(event.target.value)}
      />
      <Input
        required
        autoComplete="family-name"
        label={t("invitation.lastName")}
        value={lastName}
        onChange={(event) => setLastName(event.target.value)}
      />
      <Input
        autoComplete="additional-name"
        label={t("invitation.middleName")}
        value={middleName}
        onChange={(event) => setMiddleName(event.target.value)}
      />
      <Input
        required
        type="password"
        minLength={8}
        autoComplete="new-password"
        label={t("invitation.password")}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Button type="submit" fullWidth loading={pending}>
        {t(registered ? "invitation.retryAccept" : "invitation.registerAndAccept")}
      </Button>
    </form>
  );
}

function ExistingAccount({
  invitation,
  onTerminal,
}: {
  invitation: PublicInvitation;
  onTerminal: (state: TerminalState) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const { data: session, isPending } = auth.useSession();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isPending) return <Spinner label={t("common.loading")} />;
  if (session && session.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <State
        title={t("invitation.wrongAccountTitle")}
        body={t("invitation.wrongAccountBody", { email: session.user.email })}
        action={
          <Button variant="secondary" onClick={() => void auth.signOut()}>
            {t("common.signOut")}
          </Button>
        }
      />
    );
  }

  const authenticate = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await auth.signIn.email({ email: invitation.email, password });
      if (result.error) throw new Error(result.error.message ?? t("auth.login.genericError"));
      // Better Auth updates its shared session atom here. AuthQueryBoundary may
      // remount the route, which is intentional: the fresh matching-account view
      // presents the decision actions without continuing this stale handler.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.login.genericError"));
    } finally {
      setPending(false);
    }
  };

  const act = async (action: "accept" | "reject") => {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      if (action === "accept") await acceptInvitation(invitation.id);
      else await rejectInvitation(invitation.id);
      onTerminal(action === "accept" ? "accepted" : "rejected");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("invitation.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!session ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void authenticate();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <Alert tone="info">{t("invitation.signInHint")}</Alert>
          <Input label={t("invitation.email")} value={invitation.email} readOnly />
          <Input
            type="password"
            autoComplete="current-password"
            label={t("invitation.password")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" fullWidth loading={pending}>
            {t("invitation.signIn")}
          </Button>
        </form>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Button loading={pending} onClick={() => void act("accept")} style={{ flex: 1 }}>
            {t("invitation.accept")}
          </Button>
          <Button disabled={pending} variant="secondary" onClick={() => void act("reject")}>
            {t("invitation.reject")}
          </Button>
        </div>
      )}
    </div>
  );
}

function State({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ margin: 0, font: "var(--text-h1)", color: "var(--fg-1)" }}>{title}</h1>
      <p style={{ margin: 0, font: "var(--text-body)", color: "var(--fg-2)" }}>{body}</p>
      {action ? <div>{action}</div> : null}
    </section>
  );
}
