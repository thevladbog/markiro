import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { OfficeIcon } from "./OfficeIcon.js";
import { UserAvatar } from "./UserAvatar.js";

export interface UserMenuProps {
  userId: string;
  avatarVersion: number | null | undefined;
  name: string;
  login: string;
  /** The role as the person reads it: «Администратор». */
  roleLabel: string;
  onProfile: () => void;
  onChangePassword: () => void;
  onSignOut: () => void;
}

/**
 * The signed-in person in the office's top bar: name and role on a trigger that opens a menu of
 * «Профиль», «Сменить пароль» and «Выйти из офиса» (it replaces the two separate buttons). Menu semantics:
 * the first entry takes the focus on opening, the arrows, Home and End move, Escape closes and
 * returns to the trigger, Tab and a press outside close.
 */
export function UserMenu({
  userId,
  avatarVersion,
  name,
  login,
  roleLabel,
  onProfile,
  onChangePassword,
  onSignOut,
}: UserMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Which entry takes the focus when the menu opens.
  const focusOnOpen = useRef(0);
  const entries = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const close = (toTrigger: boolean) => {
    setOpen(false);
    if (toTrigger) rootRef.current?.querySelector<HTMLElement>(":scope > button")?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const list = entries();
    list[focusOnOpen.current < 0 ? list.length - 1 : focusOnOpen.current]?.focus();
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusOnOpen.current = event.key === "ArrowDown" ? 0 : -1;
    setOpen(true);
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = entries();
    const current = list.findIndex((el) => el === document.activeElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(current + 1);
    else if (event.key === "ArrowUp") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") setOpen(false);
  };

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={rootRef} className="user-menu">
      <Button
        variant="secondary"
        className="user-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          focusOnOpen.current = 0;
          setOpen((value) => !value);
        }}
        onKeyDown={onTriggerKey}
      >
        <UserAvatar name={name} size={32} userId={userId} avatarVersion={avatarVersion} />
        <span className="user-menu__who">
          <span className="user-menu__name">{name}</span>
          <span className="user-menu__role">{roleLabel}</span>
        </span>
        <OfficeIcon name="caretDown" size={16} />
      </Button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t("office.header.userMenu")}
          className="user-menu__panel"
          onKeyDown={onMenuKey}
        >
          <div className="user-menu__identity">
            <UserAvatar name={name} size={40} userId={userId} avatarVersion={avatarVersion} />
            <div className="user-menu__identity-text">
              <span className="user-menu__identity-name">{name}</span>
              <span className="user-menu__identity-meta">{`${roleLabel} · ${login}`}</span>
            </div>
          </div>
          <Button
            variant="secondary"
            role="menuitem"
            tabIndex={-1}
            className="user-menu__item"
            onClick={() => run(onProfile)}
          >
            <OfficeIcon name="user" />
            {t("office.header.profile")}
          </Button>
          <Button
            variant="secondary"
            role="menuitem"
            tabIndex={-1}
            className="user-menu__item"
            onClick={() => run(onChangePassword)}
          >
            <OfficeIcon name="key" />
            {t("office.password.open")}
          </Button>
          <Button
            variant="secondary"
            role="menuitem"
            tabIndex={-1}
            className="user-menu__item"
            onClick={() => run(onSignOut)}
          >
            <OfficeIcon name="signOut" />
            {t("office.header.signOut")}
          </Button>
        </div>
      )}
    </div>
  );
}
