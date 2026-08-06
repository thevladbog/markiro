import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import type { Location, NavigateFunction } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import {
  useCreateEmployee,
  useUpdateEmployee,
  type CreateEmployeeInput,
  type EmployeeDto,
} from "./api.js";
import { EmployeeBadgesSection } from "./EmployeeBadgesSection.js";
import {
  EMPLOYEE_PROFILE_FORM_ID,
  EmployeeProfileForm,
  type EmployeeFormValues,
} from "./EmployeeProfileForm.js";
import {
  EmployeeSectionNav,
  type EmployeeSectionId,
  type EmployeeSectionNavItem,
} from "./EmployeeSectionNav.js";
import {
  EmployeeStationAccessSection,
  type EmployeeAccessSectionStatus,
} from "./EmployeeStationAccessSection.js";

export interface EmployeesPanelContext {
  employees: EmployeeDto[];
  employeesPending: boolean;
  employeesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type EmployeesPanelLocationState = { employeesBackground: true };

type PanelMode = "create" | "edit";

interface SectionFlags {
  profile: boolean;
  badges: boolean;
  access: boolean;
}

const CLEAN_SECTIONS: SectionFlags = { profile: false, badges: false, access: false };
const SECTION_ORDER: EmployeeSectionId[] = ["profile", "badges", "station-access"];

export function closeEmployeePanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as EmployeesPanelLocationState | null)?.employeesBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/employees", { replace: true });
  }
}

function usePanelContext() {
  const context = useOutletContext<EmployeesPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeEmployeePanel(location, navigate), [location, navigate]);
  return { context, close };
}

function panelTitle(mode: PanelMode, t: ReturnType<typeof useTranslation>["t"]): string {
  return mode === "create"
    ? t("pages.employees.form.createTitle")
    : t("pages.employees.form.editTitle");
}

function PanelSkeleton({ mode }: { mode: PanelMode }) {
  const { t } = useTranslation();

  return (
    <div
      className={
        mode === "edit"
          ? "mk-employee-panel-skeleton mk-employee-panel-skeleton--edit"
          : "mk-employee-panel-skeleton"
      }
    >
      <Spinner label={t("common.loading")} />
      <div className="mk-employee-panel-skeleton__shape" aria-hidden="true">
        {mode === "edit" ? <span className="mk-employee-panel-skeleton__rail" /> : null}
        <span className="mk-employee-panel-skeleton__content">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

function PanelState({ mode }: { mode: PanelMode }) {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();

  return (
    <SidePanel
      open
      size={mode === "edit" ? "complex" : "standard"}
      title={panelTitle(mode, t)}
      closeLabel={t("common.close")}
      onClose={close}
    >
      {context.employeesPending ? (
        <PanelSkeleton mode={mode} />
      ) : (
        <div className="mk-employees-section-state">
          <Alert tone="error">{t("pages.employees.form.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
              {t("pages.employees.form.retry")}
            </Button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

interface DiscardDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DiscardDialog({ open, onCancel, onConfirm }: DiscardDialogProps) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={open}
      title={t("pages.employees.form.discardTitle")}
      description={t("pages.employees.form.discardBody")}
      cancelLabel={t("pages.employees.form.continueEditing")}
      confirmLabel={t("pages.employees.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function EmployeeCreatePanelRoute(): ReactElement {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateEmployee();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);

  if (context.employeesPending || context.employeesError) return <PanelState mode="create" />;

  return (
    <>
      <SidePanel
        open
        size="standard"
        busy={mutation.isPending}
        title={t("pages.employees.form.createTitle")}
        closeLabel={t("common.close")}
        onClose={guard.requestClose}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={guard.requestClose}
            >
              {t("pages.employees.cancel")}
            </Button>
            <Button type="submit" form={EMPLOYEE_PROFILE_FORM_ID} loading={mutation.isPending}>
              {t("pages.employees.form.submitCreate")}
            </Button>
          </>
        }
      >
        <EmployeeProfileForm
          mode="create"
          submitting={mutation.isPending}
          submissionError={error}
          onDirtyChange={guard.setDirty}
          onSubmit={async (input) => {
            try {
              setError(null);
              await mutation.mutateAsync(input);
              toast("ok", t("pages.employees.toasts.createSuccess"));
              guard.finish();
            } catch (cause) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.employees.toasts.createError"),
              );
            }
          }}
        />
      </SidePanel>
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}

export function EmployeeEditPanelRoute(): ReactElement {
  const { employeeId } = useParams();
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const updateMutation = useUpdateEmployee();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<SectionFlags>(CLEAN_SECTIONS);
  const [busy, setBusy] = useState({ badges: false, access: false });
  const [errors, setErrors] = useState<SectionFlags>(CLEAN_SECTIONS);
  const [accessStatus, setAccessStatus] = useState<EmployeeAccessSectionStatus>("loading");
  const [activeSection, setActiveSection] = useState<EmployeeSectionId>("profile");
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const profileSectionRef = useRef<HTMLElement>(null);
  const badgesHostRef = useRef<HTMLDivElement>(null);
  const accessHostRef = useRef<HTMLDivElement>(null);
  const employee = context.employees.find((item) => item.id === employeeId);
  const employeeFullName = employee?.fullName;
  const employeeRole = employee?.role;
  const initialValues = useMemo<EmployeeFormValues | undefined>(
    () =>
      employeeFullName !== undefined
        ? {
            fullName: employeeFullName,
            role: employeeRole ?? "",
          }
        : undefined,
    // Primitive dependencies keep unrelated employee-list refetches from replacing
    // a dirty Profile form's initial-value object.
    [employeeFullName, employeeRole],
  );
  const panelDirty = dirty.profile || dirty.badges || dirty.access;
  const panelBusy = updateMutation.isPending || busy.badges || busy.access;
  const guard = useRoutePanelGuard(close, panelBusy);
  const setGuardDirty = guard.setDirty;

  const reportProfileDirty = useCallback((value: boolean) => {
    setDirty((current) => (current.profile === value ? current : { ...current, profile: value }));
  }, []);
  const reportProfileError = useCallback((value: boolean) => {
    setErrors((current) => (current.profile === value ? current : { ...current, profile: value }));
  }, []);
  const reportBadgesDirty = useCallback((value: boolean) => {
    setDirty((current) => (current.badges === value ? current : { ...current, badges: value }));
  }, []);
  const reportAccessDirty = useCallback((value: boolean) => {
    setDirty((current) => (current.access === value ? current : { ...current, access: value }));
  }, []);
  const reportBadgesBusy = useCallback((value: boolean) => {
    setBusy((current) => (current.badges === value ? current : { ...current, badges: value }));
  }, []);
  const reportAccessBusy = useCallback((value: boolean) => {
    setBusy((current) => (current.access === value ? current : { ...current, access: value }));
  }, []);
  const reportBadgesError = useCallback((value: boolean) => {
    setErrors((current) => (current.badges === value ? current : { ...current, badges: value }));
  }, []);
  const reportAccessError = useCallback((value: boolean) => {
    setErrors((current) => (current.access === value ? current : { ...current, access: value }));
  }, []);
  const reportAccessStatus = useCallback((value: EmployeeAccessSectionStatus) => {
    setAccessStatus((current) => (current === value ? current : value));
  }, []);

  useEffect(() => {
    setGuardDirty(panelDirty);
  }, [panelDirty, setGuardDirty]);

  const getSectionElement = useCallback((id: EmployeeSectionId): HTMLElement | null => {
    if (id === "profile") return profileSectionRef.current;
    if (id === "badges") {
      return (
        badgesHostRef.current?.querySelector<HTMLElement>(".mk-employee-badges-section") ?? null
      );
    }
    return (
      accessHostRef.current?.querySelector<HTMLElement>(".mk-employee-station-access-section") ??
      null
    );
  }, []);

  const registerProfileSection = useCallback((section: HTMLElement | null) => {
    profileSectionRef.current = section;
    const nextScrollRoot = section?.closest(".mk-side-panel__body");
    setScrollRoot(nextScrollRoot instanceof HTMLElement ? nextScrollRoot : null);
  }, []);

  const navigateToSection = useCallback(
    (id: EmployeeSectionId) => {
      setActiveSection(id);
      const section = getSectionElement(id);
      const heading = section?.querySelector<HTMLElement>("h3");
      heading?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
    },
    [getSectionElement],
  );

  useEffect(() => {
    if (!scrollRoot) return undefined;

    const updateActiveSection = () => {
      const threshold = scrollRoot.scrollTop + 32;
      let nextSection: EmployeeSectionId = "profile";
      SECTION_ORDER.forEach((id) => {
        const section = getSectionElement(id);
        if (section && section.offsetTop <= threshold) nextSection = id;
      });
      setActiveSection(nextSection);
    };

    scrollRoot.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => scrollRoot.removeEventListener("scroll", updateActiveSection);
  }, [getSectionElement, scrollRoot]);

  if (context.employeesPending || context.employeesError) return <PanelState mode="edit" />;

  if (!employee || !initialValues) {
    return (
      <SidePanel
        open
        size="complex"
        title={t("pages.employees.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="warn">{t("pages.employees.form.notFound")}</Alert>
      </SidePanel>
    );
  }

  const activeBadgeCount = employee.badges.filter((badge) => badge.revokedAt === null).length;
  const navItems: EmployeeSectionNavItem[] = [
    {
      id: "profile",
      label: t("pages.employees.sections.profile"),
      hasError: errors.profile,
    },
    {
      id: "badges",
      label: t("pages.employees.badges.title"),
      meta: activeBadgeCount,
      hasError: errors.badges,
    },
    {
      id: "station-access",
      label: t("pages.employees.stationAccess.title"),
      meta: t(`pages.employees.stationAccess.status.${accessStatus}`),
      hasError: errors.access,
    },
  ];
  const identity = employee.role
    ? t("pages.employees.form.editIdentityWithRole", {
        name: employee.fullName,
        role: employee.role,
      })
    : t("pages.employees.form.editIdentity", { name: employee.fullName });

  const updateProfile = async (input: CreateEmployeeInput) => {
    try {
      setProfileError(null);
      setErrors((current) => (current.profile ? { ...current, profile: false } : current));
      await updateMutation.mutateAsync({ id: employee.id, input });
      toast("ok", t("pages.employees.toasts.updateSuccess"));
      guard.finish();
    } catch (cause) {
      setProfileError(
        cause instanceof ApiRequestError ? cause.message : t("pages.employees.form.updateError"),
      );
      setErrors((current) => (current.profile ? current : { ...current, profile: true }));
    }
  };

  return (
    <>
      <SidePanel
        open
        size="complex"
        busy={panelBusy}
        title={t("pages.employees.form.editTitle")}
        description={identity}
        closeLabel={t("common.close")}
        className="mk-employee-edit-panel"
        onClose={guard.requestClose}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={panelBusy}
              onClick={guard.requestClose}
            >
              {t("pages.employees.cancel")}
            </Button>
            <Button
              type="submit"
              form={EMPLOYEE_PROFILE_FORM_ID}
              loading={updateMutation.isPending}
              disabled={panelBusy}
            >
              {t("pages.employees.form.submitUpdate")}
            </Button>
          </>
        }
      >
        <div className="mk-employee-edit-panel__layout">
          <EmployeeSectionNav
            items={navItems}
            activeId={activeSection}
            onNavigate={navigateToSection}
          />
          <div className="mk-employee-edit-panel__sections">
            <section
              ref={registerProfileSection}
              className="mk-employee-profile-section"
              role="region"
              aria-label={t("pages.employees.sections.profile")}
            >
              <h3 className="mk-employee-profile-section__title" tabIndex={-1}>
                {t("pages.employees.sections.profile")}
              </h3>
              <EmployeeProfileForm
                mode="edit"
                initialValues={initialValues}
                submitting={updateMutation.isPending}
                submissionError={profileError}
                onSubmit={updateProfile}
                onDirtyChange={reportProfileDirty}
                onErrorChange={reportProfileError}
              />
            </section>
            <div ref={badgesHostRef} className="mk-employee-edit-panel__section-host">
              <EmployeeBadgesSection
                employee={employee}
                onDirtyChange={reportBadgesDirty}
                onBusyChange={reportBadgesBusy}
                onErrorChange={reportBadgesError}
              />
            </div>
            <div ref={accessHostRef} className="mk-employee-edit-panel__section-host">
              <EmployeeStationAccessSection
                employee={employee}
                onDirtyChange={reportAccessDirty}
                onBusyChange={reportAccessBusy}
                onErrorChange={reportAccessError}
                onStatusChange={reportAccessStatus}
              />
            </div>
          </div>
        </div>
      </SidePanel>
      <DiscardDialog
        open={guard.confirmOpen}
        onCancel={guard.cancelDiscard}
        onConfirm={guard.confirmDiscard}
      />
    </>
  );
}
