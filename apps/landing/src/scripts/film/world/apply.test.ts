import { Group, PointLight } from "three";
import { describe, expect, it } from "vitest";

import {
  animationAt,
  PALLET_CAPACITY,
  PRODUCT_KINDS,
  type FilmAnimationState,
} from "../animations";
import { lightingAt } from "../lighting";
import { applyAnimation } from "./apply";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { createLightRig } from "./rig";
import { blankTextureFactory, createScreenTextures } from "./textures";

function setup() {
  const kit = new Kit();
  const screens = createScreenTextures(blankTextureFactory);
  const handles = buildDistrict(kit, new Group(), screens);
  return { kit, screens, handles };
}

const state = (overrides: Partial<FilmAnimationState>): FilmAnimationState => ({
  ...animationAt(0),
  ...overrides,
});

describe("applying film state to the scene", () => {
  it("shows as many case products and pallet cases as the state asks for", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ caseFill: 3, palletCases: 5 }), false, 0);
    expect(handles.caseProducts.filter((product) => product.visible)).toHaveLength(3);
    expect(handles.palletCases.filter((item) => item.visible)).toHaveLength(5);
  });

  it("labels the pallet only once its last case is on", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ palletCases: PALLET_CAPACITY - 1 }), false, 0);
    expect(handles.palletLabel.visible).toBe(false);
    applyAnimation(handles, kit, screens, state({ palletCases: PALLET_CAPACITY }), false, 0);
    expect(handles.palletLabel.visible).toBe(true);
  });

  it("stacks the offline queue and hides it once it is flushed", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(
      handles,
      kit,
      screens,
      state({ queueCount: 5, queueFlush: 0, networkOnline: false }),
      false,
      0,
    );
    expect(handles.queueTiles.filter((tile) => tile.visible)).toHaveLength(5);
    expect(handles.mastLamp.material).toBe(kit.signals.offline);
    applyAnimation(
      handles,
      kit,
      screens,
      state({ queueCount: 12, queueFlush: 1, networkOnline: true }),
      false,
      0,
    );
    expect(handles.queueTiles.filter((tile) => tile.visible)).toHaveLength(0);
    expect(handles.mastLamp.material).toBe(kit.signals.verified);
  });

  it("shows one product kind per belt slot and paints its code", () => {
    const { kit, screens, handles } = setup();
    const film = animationAt(1.7);
    applyAnimation(handles, kit, screens, film, false, 0);
    film.belt.forEach((item, index) => {
      const slot = handles.belt[index];
      expect(PRODUCT_KINDS.filter((kind) => slot?.products[kind].visible)).toEqual([item.kind]);
      const expected =
        item.code === "verified"
          ? kit.signals.verified
          : item.code === "rejected"
            ? kit.signals.rejected
            : kit.material("codeIdle");
      expect(slot?.codes.every((code) => code.material === expected)).toBe(true);
    });
  });

  it("switches screens to the dark interface at night", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ kioskStep: 2 }), true, 1);
    expect(handles.monitorScreen.material.map).toBe(screens.station(true));
    expect(handles.kioskScreen.material.map).toBe(screens.kiosk(true, 2));
  });

  it("turns the interior lamps on only after dusk", () => {
    const { handles } = setup();
    const rig = createLightRig(handles, 1024);
    const lamps = () => {
      const found: PointLight[] = [];
      rig.root.traverse((node) => {
        if (node instanceof PointLight) found.push(node);
      });
      return found;
    };
    rig.apply(lightingAt(0));
    expect(lamps().every((lamp) => lamp.intensity === 0)).toBe(true);
    rig.apply(lightingAt(1));
    expect(lamps().some((lamp) => lamp.intensity > 0)).toBe(true);
  });
});
