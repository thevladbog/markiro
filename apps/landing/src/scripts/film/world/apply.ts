import type { Material, MeshBasicMaterial, Texture } from "three";

import { PRODUCT_KINDS, type FilmAnimationState } from "../animations";
import type { Kit } from "./kit";
import { BELT_TOP, CONVEYOR, type PlantHandles } from "./plant";
import type { ScreenTextures } from "./textures";

const QUEUE_STEP = 0.14;
/** Fully lit office windows glow at 0.85 of their colour, below the bloom threshold. */
const WINDOW_GLOW = 0.85;

function setMap(material: MeshBasicMaterial, texture: Texture): void {
  if (material.map !== texture) material.map = texture;
}

export function applyAnimation(
  handles: PlantHandles,
  kit: Kit,
  screens: ScreenTextures,
  state: FilmAnimationState,
  dark: boolean,
  lamps: number,
): void {
  state.belt.forEach((item, index) => {
    const slot = handles.belt[index];
    if (slot === undefined) return;
    slot.group.visible = item.visible;
    slot.group.position.set(item.x, BELT_TOP - item.aside * 0.3, CONVEYOR.z + item.aside * 0.62);
    for (const kind of PRODUCT_KINDS) slot.products[kind].visible = kind === item.kind;
    const material: Material =
      item.code === "verified"
        ? kit.signals.verified
        : item.code === "rejected"
          ? kit.signals.rejected
          : kit.material("codeIdle");
    for (const code of slot.codes) code.material = material;
  });
  handles.caseProducts.forEach((product, index) => {
    product.visible = index < state.caseFill;
  });
  handles.labelTongue.visible = state.labelOut > 0.001;
  handles.labelTongue.scale.set(1, Math.max(0.001, state.labelOut), 1);
  handles.palletCases.forEach((item, index) => {
    item.visible = index < state.palletCases;
  });
  const [qx, qy, qz] = handles.queueBase;
  handles.queueTiles.forEach((tile, index) => {
    tile.visible = index < state.queueCount && state.queueFlush < 1;
    tile.position.set(
      qx,
      qy + 0.04 + index * QUEUE_STEP + state.queueFlush * (7 + index * 0.45),
      qz,
    );
    tile.material = state.queueFlush > 0 ? kit.signals.verified : kit.material("graphite");
  });
  handles.mastLamp.material = state.networkOnline ? kit.signals.verified : kit.signals.offline;
  setMap(handles.monitorScreen.material, screens.station(dark));
  setMap(handles.kioskScreen.material, screens.kiosk(dark, state.kioskStep));
  handles.windows.color.set(kit.colorOf("glass"));
  handles.windows.emissiveIntensity = WINDOW_GLOW * lamps * (0.35 + 0.65 * state.officeLights);
}
