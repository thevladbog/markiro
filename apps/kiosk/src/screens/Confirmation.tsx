import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CartState, KioskCartLine } from "../session/cart.js";
import { bottleCount, boxLines, looseLines } from "../session/cart.js";
import { pageSizeFor } from "../session/pagination.js";
import { CancelOperation } from "../ui/CancelOperation.js";
import { ItemKindIcon } from "../ui/ItemKindIcon.js";
import { PagedLines } from "../ui/PagedLines.js";
import { formatMoney, moneyFormat, totalKopecks } from "./money.js";

export interface ConfirmationProps {
  cart: CartState;
  showPrices: boolean;
  reasonName: string | null;
  onBack: () => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

function codeOf(line: KioskCartLine): string {
  return line.kind === "box" ? line.sscc : line.serial;
}

export function Confirmation({
  cart,
  showPrices,
  reasonName,
  onBack,
  onConfirm,
  onCancel,
}: ConfirmationProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() =>
    pageSizeFor(window.innerWidth, window.innerHeight),
  );
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const measure = () => setPageSize(pageSizeFor(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", measure);
    return () => {
      mounted.current = false;
      window.removeEventListener("resize", measure);
    };
  }, []);

  const bottles = bottleCount(cart);
  const total = showPrices ? totalKopecks(cart.lines) : null;
  const reasonValid = cart.reason === "buy" || reasonName !== null;
  const money = moneyFormat(i18n.language);
  const confirm = async () => {
    if (locked.current || !reasonValid) return;
    locked.current = true;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <main className="kiosk-screen kiosk-flow kiosk-confirmation">
      <header className="kiosk-flow__header">
        <button className="kiosk-control kiosk-flow__back" type="button" onClick={onBack}>
          {t("flow.back")}
        </button>
        <div>
          <span className="kiosk-flow__eyebrow">{t("confirmation.eyebrow")}</span>
          <h1>{t("confirmation.title")}</h1>
        </div>
        <CancelOperation onConfirm={onCancel} />
      </header>

      <div className="kiosk-confirmation__workspace">
        <section className="kiosk-confirmation__facts" aria-label={t("confirmation.summaryLabel")}>
          <div className="kiosk-confirmation__operation">
            <span>{t("confirmation.operation")}</span>
            <strong>
              {cart.reason === "buy" ? t("operation.buy.title") : t("operation.writeoff.title")}
            </strong>
          </div>
          {cart.reason === "writeoff" && reasonName ? (
            <div>
              <span>{t("confirmation.reason")}</span>
              <strong title={reasonName}>{reasonName}</strong>
            </div>
          ) : null}
          <div>
            <span>{t("confirmation.contents")}</span>
            <strong>
              {t("cart.summary", {
                positions: t("cart.positions", { count: cart.lines.length }),
                bottles: t("cart.bottles", { count: bottles }),
              })}
            </strong>
            <small>
              {t("confirmation.composition", {
                loose: looseLines(cart).length,
                boxes: boxLines(cart).length,
              })}
            </small>
          </div>
          {showPrices && total !== null ? (
            <div>
              <span>{t("confirmation.total")}</span>
              <strong>{t("cart.price", { value: formatMoney(total, money) })}</strong>
            </div>
          ) : null}
          {!reasonValid ? <p role="alert">{t("confirmation.reasonUnavailable")}</p> : null}
        </section>

        <section
          className="kiosk-confirmation__summary"
          aria-label={t("confirmation.lines")}
          style={{ overflow: "hidden" }}
        >
          <PagedLines
            items={cart.lines}
            pageSize={pageSize}
            page={page}
            onPageChange={setPage}
            renderItem={(line) => (
              <div className="kiosk-confirmation-line">
                <ItemKindIcon kind={line.kind} />
                <span>
                  <strong title={line.name}>{line.name}</strong>
                  <small title={codeOf(line)}>{codeOf(line)}</small>
                </span>
                <b>{t("cart.bottles", { count: line.bottleCount })}</b>
              </div>
            )}
          />
        </section>
      </div>

      <footer className="kiosk-flow__footer kiosk-confirmation__footer">
        <span>{t("confirmation.check")}</span>
        <button
          className="kiosk-control kiosk-flow__primary"
          type="button"
          disabled={pending || !reasonValid}
          onClick={() => void confirm()}
        >
          {pending ? t("confirmation.saving") : t("confirmation.confirm", { count: bottles })}
        </button>
      </footer>
    </main>
  );
}
