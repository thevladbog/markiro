import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import type { Location, NavigateFunction } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useRoutePanelGuard } from "../../lib/useRoutePanelGuard.js";
import { useCreateKiosk, useUpdateKiosk, type KioskDto } from "./api.js";
import { KioskProductsSection } from "./KioskProductsSection.js";
import {
  KIOSK_PROFILE_FORM_ID,
  KioskProfileForm,
  type KioskFormValues,
} from "./KioskProfileForm.js";
import {
  KioskSectionNav,
  type KioskSectionId,
  type KioskSectionNavItem,
} from "./KioskSectionNav.js";
import { getKioskOperationalState } from "./kioskState.js";

export interface KiosksPanelContext {
  kiosks: KioskDto[];
  kiosksPending: boolean;
  kiosksError: boolean;
  kiosksResolved: boolean;
  retryPanelData: () => Promise<void>;
}

export type KiosksPanelLocationState = { kiosksBackground: true };

type PanelMode = "create" | "edit";

type SectionFlags = { profile: boolean; products: boolean };

const CLEAN_SECTIONS: SectionFlags = { profile: false, products: false };
const SECTION_ORDER: KioskSectionId[] = ["profile", "products"];

export function closeKioskPanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as KiosksPanelLocationState | null)?.kiosksBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/kiosks", { replace: true });
  }
}

function usePanelContext() {
  const context = useOutletContext<KiosksPanelContext>();
  const location = useLocation();
  const navigate = useNavigate();
  const close = useCallback(() => closeKioskPanel(location, navigate), [location, navigate]);
  return { context, close };
}

function panelTitle(mode: PanelMode, t: ReturnType<typeof useTranslation>["t"]): string {
  return mode === "create" ? t("pages.kiosks.form.createTitle") : t("pages.kiosks.form.editTitle");
}

function PanelSkeleton({ mode }: { mode: PanelMode }) {
  const { t } = useTranslation();

  return (
    <div
      className={
        mode === "edit"
          ? "mk-kiosk-panel-skeleton mk-kiosk-panel-skeleton--edit"
          : "mk-kiosk-panel-skeleton"
      }
    >
      <Spinner label={t("common.loading")} />
      <div className="mk-kiosk-panel-skeleton__shape" aria-hidden="true">
        {mode === "edit" ? <span className="mk-kiosk-panel-skeleton__rail" /> : null}
        <span className="mk-kiosk-panel-skeleton__content">
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
      {context.kiosksPending ? (
        <PanelSkeleton mode={mode} />
      ) : (
        <div className="mk-kiosks-section-state">
          <Alert tone="error">{t("pages.kiosks.form.loadError")}</Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => void context.retryPanelData()}>
              {t("pages.kiosks.form.retry")}
            </Button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

function DiscardDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={open}
      title={t("pages.kiosks.form.discardTitle")}
      description={t("pages.kiosks.form.discardBody")}
      cancelLabel={t("pages.kiosks.form.continueEditing")}
      confirmLabel={t("pages.kiosks.form.discardAction")}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function KioskCreatePanelRoute(): ReactElement {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const mutation = useCreateKiosk();
  const [error, setError] = useState<string | null>(null);
  const guard = useRoutePanelGuard(close, mutation.isPending);

  if (context.kiosksPending || (context.kiosksError && !context.kiosksResolved)) {
    return <PanelState mode="create" />;
  }

  return (
    <>
      <SidePanel
        open
        size="standard"
        busy={mutation.isPending}
        title={t("pages.kiosks.form.createTitle")}
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
              {t("pages.kiosks.cancel")}
            </Button>
            <Button type="submit" form={KIOSK_PROFILE_FORM_ID} loading={mutation.isPending}>
              {t("pages.kiosks.form.submitCreate")}
            </Button>
          </>
        }
      >
        <KioskProfileForm
          submitting={mutation.isPending}
          submissionError={error}
          onDirtyChange={guard.setDirty}
          onSubmit={async (input) => {
            try {
              setError(null);
              await mutation.mutateAsync(input);
              toast("ok", t("pages.kiosks.toasts.createSuccess"));
              guard.finish();
            } catch (cause) {
              setError(
                cause instanceof ApiRequestError
                  ? cause.message
                  : t("pages.kiosks.form.createError"),
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

export function KioskEditPanelRoute(): ReactElement {
  const { kioskId } = useParams();
  return <KioskEditPanelContent key={kioskId ?? "missing"} kioskId={kioskId} />;
}

function KioskEditPanelContent({ kioskId }: { kioskId: string | undefined }): ReactElement {
  const { t } = useTranslation();
  const { context, close } = usePanelContext();
  const updateMutation = useUpdateKiosk();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<SectionFlags>(CLEAN_SECTIONS);
  const [busy, setBusy] = useState<SectionFlags>(CLEAN_SECTIONS);
  const [errors, setErrors] = useState<SectionFlags>(CLEAN_SECTIONS);
  const [activeSection, setActiveSection] = useState<KioskSectionId>("profile");
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const profileSectionRef = useRef<HTMLElement>(null);
  const productsHostRef = useRef<HTMLDivElement>(null);
  const kiosk = context.kiosks.find((item) => item.id === kioskId);
  const initialValues = useMemo<KioskFormValues | undefined>(
    () =>
      kiosk
        ? {
            name: kiosk.name,
            location: kiosk.location ?? "",
            dayLimitPerEmployee: String(kiosk.dayLimitPerEmployee),
            showPrices: kiosk.showPrices,
          }
        : undefined,
    [kiosk],
  );
  const panelDirty = dirty.profile || dirty.products;
  const panelBusy = updateMutation.isPending || busy.products;
  const guard = useRoutePanelGuard(close, panelBusy);
  const setGuardDirty = guard.setDirty;

  const reportProfileDirty = useCallback((value: boolean) => {
    setDirty((current) => (current.profile === value ? current : { ...current, profile: value }));
  }, []);
  const reportProductsDirty = useCallback((value: boolean) => {
    setDirty((current) => (current.products === value ? current : { ...current, products: value }));
  }, []);
  const reportProductsBusy = useCallback((value: boolean) => {
    setBusy((current) => (current.products === value ? current : { ...current, products: value }));
  }, []);
  const reportProductsError = useCallback((value: boolean) => {
    setErrors((current) =>
      current.products === value ? current : { ...current, products: value },
    );
  }, []);

  useEffect(() => {
    setGuardDirty(panelDirty);
  }, [panelDirty, setGuardDirty]);

  const getSectionElement = useCallback((id: KioskSectionId): HTMLElement | null => {
    if (id === "profile") return profileSectionRef.current;
    return (
      productsHostRef.current?.querySelector<HTMLElement>(".mk-kiosk-products-section") ?? null
    );
  }, []);

  const registerProfileSection = useCallback((section: HTMLElement | null) => {
    profileSectionRef.current = section;
    const nextScrollRoot = section?.closest(".mk-side-panel__body");
    setScrollRoot(nextScrollRoot instanceof HTMLElement ? nextScrollRoot : null);
  }, []);

  const activateSection = useCallback(
    (id: KioskSectionId) => {
      setActiveSection(id);
      const section = getSectionElement(id);
      const heading = section?.querySelector<HTMLElement>("h3");
      section?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
    },
    [getSectionElement],
  );

  useEffect(() => {
    if (!scrollRoot) return undefined;

    const updateActiveSection = () => {
      const scrollRootTop = scrollRoot.getBoundingClientRect().top;
      const threshold = scrollRoot.scrollTop + 32;
      let nextSection: KioskSectionId = "profile";
      SECTION_ORDER.forEach((id) => {
        const section = getSectionElement(id);
        if (!section) return;
        const sectionTop =
          section.getBoundingClientRect().top - scrollRootTop + scrollRoot.scrollTop;
        if (sectionTop <= threshold) nextSection = id;
      });
      if (
        scrollRoot.scrollHeight > scrollRoot.clientHeight &&
        scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 1 &&
        getSectionElement("products")
      ) {
        nextSection = "products";
      }
      setActiveSection(nextSection);
    };

    scrollRoot.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => scrollRoot.removeEventListener("scroll", updateActiveSection);
  }, [getSectionElement, scrollRoot]);

  if (context.kiosksPending || (context.kiosksError && !context.kiosksResolved)) {
    return <PanelState mode="edit" />;
  }

  if (!kiosk || !initialValues) {
    return (
      <SidePanel
        open
        size="complex"
        title={t("pages.kiosks.form.editTitle")}
        closeLabel={t("common.close")}
        onClose={close}
      >
        <Alert tone="warn">{t("pages.kiosks.form.notFound")}</Alert>
      </SidePanel>
    );
  }

  const state = getKioskOperationalState(kiosk, Date.now());
  const description = t("pages.kiosks.form.editIdentity", {
    name: kiosk.name,
    state: t(`pages.kiosks.states.${state}`),
  });
  const navItems: KioskSectionNavItem[] = [
    {
      id: "profile",
      label: t("pages.kiosks.sections.profile"),
      hasError: profileError !== null || errors.profile,
    },
    {
      id: "products",
      label: t("pages.kiosks.products.title"),
      meta: busy.products
        ? t("pages.kiosks.sections.loading")
        : t("pages.kiosks.products.selectedCount", { count: kiosk.productIds.length }),
      hasError: errors.products,
    },
  ];

  const updateProfile = async (
    input: Parameters<typeof updateMutation.mutateAsync>[0]["input"],
  ) => {
    try {
      setProfileError(null);
      await updateMutation.mutateAsync({ id: kiosk.id, input });
      toast("ok", t("pages.kiosks.toasts.updateSuccess"));
      guard.finish();
    } catch (cause) {
      setProfileError(
        cause instanceof ApiRequestError ? cause.message : t("pages.kiosks.form.updateError"),
      );
    }
  };

  return (
    <>
      <SidePanel
        open
        size="complex"
        busy={panelBusy}
        title={t("pages.kiosks.form.editTitle")}
        description={description}
        closeLabel={t("common.close")}
        className="mk-kiosk-edit-panel"
        onClose={guard.requestClose}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={panelBusy}
              onClick={guard.requestClose}
            >
              {t("pages.kiosks.cancel")}
            </Button>
            <Button
              type="submit"
              form={KIOSK_PROFILE_FORM_ID}
              loading={updateMutation.isPending}
              disabled={panelBusy}
            >
              {t("pages.kiosks.form.submitUpdate")}
            </Button>
          </>
        }
      >
        <div className="mk-kiosk-edit-panel__layout">
          <KioskSectionNav items={navItems} activeId={activeSection} onActivate={activateSection} />
          <div className="mk-kiosk-edit-panel__sections">
            <section
              ref={registerProfileSection}
              className="mk-kiosk-profile-section"
              role="region"
              aria-label={t("pages.kiosks.sections.profile")}
            >
              <h3 className="mk-kiosk-profile-section__title" tabIndex={-1}>
                {t("pages.kiosks.sections.profile")}
              </h3>
              <KioskProfileForm
                initialValues={initialValues}
                submitting={updateMutation.isPending}
                submissionError={profileError}
                onSubmit={updateProfile}
                onDirtyChange={reportProfileDirty}
              />
            </section>
            <div ref={productsHostRef} className="mk-kiosk-edit-panel__section-host">
              <KioskProductsSection
                kiosk={kiosk}
                onDirtyChange={reportProductsDirty}
                onBusyChange={reportProductsBusy}
                onErrorChange={reportProductsError}
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
