import { useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton, Input, type InputProps } from "@markiro/ui";

import { OfficeIcon } from "./OfficeIcon.js";

/**
 * A password field of the office with an eye at its end: it shows what was typed while pressed
 * on, and hides it again. Off by default; the button carries its state (`aria-pressed`) and its
 * name, so the state is never the icon alone.
 */
export function PasswordInput(props: Omit<InputProps, "type" | "suffix">) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <Input
      {...props}
      type={shown ? "text" : "password"}
      suffix={
        <IconButton
          variant="ghost"
          size="compact"
          icon={<OfficeIcon name={shown ? "eyeSlash" : "eye"} size={18} />}
          aria-label={t(shown ? "office.password.hide" : "office.password.show")}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        />
      }
    />
  );
}
