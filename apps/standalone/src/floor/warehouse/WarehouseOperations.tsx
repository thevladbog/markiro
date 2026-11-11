import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { Glyph } from "../kit/StatusIcons.js";
import { FloorFooter, FloorScreen } from "../shifts/FloorScreen.js";
import "./warehouse-operations.css";

interface WarehouseOperationsProps {
  onAssembly: () => void;
  onReprint?: () => void;
  onBack: () => void;
}

export function WarehouseOperations({ onAssembly, onReprint, onBack }: WarehouseOperationsProps) {
  const { t } = useTranslation();
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => title.current?.focus(), []);

  return (
    <FloorScreen
      title={t("floor.warehouseMenu.title")}
      titleRef={title}
      actions={
        <FloorFooter ariaLabel={t("floor.warehouseMenu.title")}>
          <Button
            size="floor"
            variant="secondary"
            icon={<Glyph name="chevron-left" />}
            onClick={onBack}
          >
            {t("floor.warehouseMenu.back")}
          </Button>
        </FloorFooter>
      }
    >
      <div className="warehouse-operations">
        <article className="warehouse-operations__option">
          <span className="warehouse-operations__mark" data-accent="true">
            <Glyph name="layers" size={36} />
          </span>
          <h3>{t("floor.warehouseMenu.assembly")}</h3>
          <p>{t("floor.warehouseMenu.assemblyHint")}</p>
          <Button size="floor" variant="primary" onClick={onAssembly}>
            {t("floor.warehouseMenu.assemblyAction")}
          </Button>
        </article>
        {onReprint !== undefined && (
          <article className="warehouse-operations__option">
            <span className="warehouse-operations__mark">
              <Glyph name="printer" size={36} />
            </span>
            <h3>{t("floor.warehouseMenu.reprint")}</h3>
            <p>{t("floor.warehouseMenu.reprintHint")}</p>
            <Button size="floor" variant="secondary" onClick={onReprint}>
              {t("floor.warehouseMenu.reprintAction")}
            </Button>
          </article>
        )}
      </div>
    </FloorScreen>
  );
}
