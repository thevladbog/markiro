import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton, Slider } from "@markiro/ui";

import { OfficeIcon } from "../OfficeIcon.js";
import {
  cropRect,
  MAX_ZOOM,
  MIN_ZOOM,
  panCrop,
  previewLayout,
  zoomCrop,
  type CropState,
} from "./avatar-crop.js";

/** The side of the cropping view (px). */
export const CROP_VIEW = 260;

/** The circles that show how the photo will look in the interface: the profile, a list, a line of text. */
const PREVIEW_SIZES = [96, 48, 32] as const;

const ZOOM_STEP = 0.25;
/** How far an arrow key moves the picture (view px). */
const KEY_STEP = 12;

export interface CropEditorProps {
  src: string;
  width: number;
  height: number;
  crop: CropState;
  disabled: boolean;
  onCrop: (crop: CropState) => void;
  onApply: () => void;
  onOther: () => void;
}

/**
 * The square crop of the profile photo: the picture under a square view with a circle on it (the
 * photo shows as a circle everywhere), dragged with the pointer or the arrow keys, zoomed by a slider
 * or the +/- keys, with the three circles it will appear in. «Применить» draws the square.
 */
export function CropEditor({
  src,
  width,
  height,
  crop,
  disabled,
  onCrop,
  onApply,
  onOther,
}: CropEditorProps) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; y: number } | null>(null);
  const rect = cropRect(width, height, crop);
  const move = (dx: number, dy: number) => onCrop(panCrop(width, height, crop, dx, dy, CROP_VIEW));
  const zoom = (value: number) => onCrop(zoomCrop(width, height, crop, value));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (from === null) return;
    drag.current = { x: event.clientX, y: event.clientY };
    move(event.clientX - from.x, event.clientY - from.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [KEY_STEP, 0],
      ArrowRight: [-KEY_STEP, 0],
      ArrowUp: [0, KEY_STEP],
      ArrowDown: [0, -KEY_STEP],
    };
    const delta = arrows[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      move(delta[0], delta[1]);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(crop.zoom + ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(crop.zoom - ZOOM_STEP);
    }
  };

  const picture = (size: number) => {
    const layout = previewLayout(width, height, rect, size);
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          width: layout.width,
          height: layout.height,
          left: layout.left,
          top: layout.top,
          maxWidth: "none",
        }}
      />
    );
  };

  return (
    <div className="profile-crop">
      <div
        className="profile-crop__view"
        style={{ width: CROP_VIEW, height: CROP_VIEW }}
        role="group"
        tabIndex={0}
        aria-label={t("office.profile.photo.area")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {picture(CROP_VIEW)}
        <span className="profile-crop__circle" aria-hidden="true" />
      </div>
      <div className="profile-crop__side">
        <p className="profile-crop__help">{t("office.profile.photo.cropHelp")}</p>
        <div
          className="profile-crop__previews"
          role="group"
          aria-label={t("office.profile.photo.previews")}
        >
          {PREVIEW_SIZES.map((size) => (
            <span
              key={size}
              className="profile-crop__preview"
              style={{ width: size, height: size }}
              data-preview-size={size}
            >
              {picture(size)}
            </span>
          ))}
        </div>
        <label className="profile-crop__scale">
          <span className="profile-crop__scale-label">{t("office.profile.photo.scale")}</span>
          <span className="profile-crop__scale-row">
            <IconButton
              variant="ghost"
              icon={<OfficeIcon name="minus" />}
              aria-label={t("office.profile.photo.zoomOut")}
              disabled={disabled || crop.zoom <= MIN_ZOOM}
              onClick={() => zoom(crop.zoom - ZOOM_STEP)}
            />
            <Slider
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={crop.zoom}
              disabled={disabled}
              aria-label={t("office.profile.photo.scale")}
              onValueChange={zoom}
            />
            <IconButton
              variant="ghost"
              icon={<OfficeIcon name="plus" />}
              aria-label={t("office.profile.photo.zoomIn")}
              disabled={disabled || crop.zoom >= MAX_ZOOM}
              onClick={() => zoom(crop.zoom + ZOOM_STEP)}
            />
          </span>
        </label>
        <div className="profile-crop__buttons">
          <Button icon={<OfficeIcon name="crop" size={20} />} disabled={disabled} onClick={onApply}>
            {t("office.profile.photo.apply")}
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={onOther}>
            {t("office.profile.photo.other")}
          </Button>
        </div>
      </div>
    </div>
  );
}
