import { animationAt } from "../animations";
import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { lightingAt, timeOfDayAt } from "../lighting";
import { TIER_SETTINGS, type QualityTier } from "../quality";
import { cameraTime } from "../timeline";
import { applyAnimation } from "./apply";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { createLightRig } from "./rig";
import { createStage } from "./stage";
import { canvasTextureFactory, createScreenTextures, type TextureFactory } from "./textures";

export const FILM_CHAPTERS = 7;

export interface WorldHandle {
  render(filmTime: number): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
  dispose(): void;
}

export function startWorld(
  canvas: HTMLCanvasElement,
  tier: QualityTier,
  textures: TextureFactory = canvasTextureFactory,
): WorldHandle {
  const settings = TIER_SETTINGS[tier];
  const stage = createStage(canvas, settings);
  const kit = new Kit();
  const screens = createScreenTextures(textures);
  const handles = buildDistrict(kit, stage.scene, screens);
  const rig = createLightRig(handles, settings.shadowMapSize);
  stage.scene.add(rig.root);
  return {
    render(filmTime) {
      const lighting = lightingAt(timeOfDayAt(filmTime));
      kit.setNightMix(lighting.materialNight);
      kit.signals.setGlow(lighting.glow, lighting.lamps);
      rig.apply(lighting);
      handles.contactShadow.opacity = lighting.contactShadow;
      applyAnimation(
        handles,
        kit,
        screens,
        animationAt(filmTime),
        lighting.uiTheme === "dark",
        lighting.lamps,
      );
      stage.render(poseAt(CAMERA_KEYS, cameraTime(filmTime, FILM_CHAPTERS)), lighting);
    },
    resize(width, height, devicePixelRatio) {
      stage.resize(width, height, devicePixelRatio);
    },
    dispose() {
      stage.dispose();
    },
  };
}
