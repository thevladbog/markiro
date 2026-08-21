import { useTranslation } from "react-i18next";

import logoOnDark from "../assets/markiro-logo-on-dark.svg";
import logoOnLight from "../assets/markiro-logo-on-light.svg";

export function MarkiroLogo({
  className,
  variant = "auto",
}: {
  className?: string;
  variant?: "auto" | "on-dark" | "on-light";
}) {
  const { t } = useTranslation();
  const classes = ["markiro-logo", `markiro-logo--${variant}`, className].filter(Boolean).join(" ");

  return (
    <picture className={classes} role="img" aria-label={t("brand.logoAlt")}>
      {variant === "auto" || variant === "on-light" ? (
        <img className="markiro-logo__on-light" src={logoOnLight} alt="" aria-hidden="true" />
      ) : null}
      {variant === "auto" || variant === "on-dark" ? (
        <img className="markiro-logo__on-dark" src={logoOnDark} alt="" aria-hidden="true" />
      ) : null}
    </picture>
  );
}
