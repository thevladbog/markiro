import {
  Color,
  HalfFloatType,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { HorizontalTiltShiftShader } from "three/addons/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/addons/shaders/VerticalTiltShiftShader.js";

import type { CameraPose, Vec2 } from "../camera-path";
import type { LightingState } from "../lighting";
import type { TierSettings } from "../quality";

export interface Stage {
  readonly scene: Scene;
  resize(width: number, height: number, devicePixelRatio: number): void;
  render(pose: CameraPose, lighting: LightingState): void;
  dispose(): void;
}

const TILT_PIXELS = 3;
const TILT_FOCUS = 0.5;

function setUniform(pass: ShaderPass | null, name: string, value: number): void {
  const uniform = pass?.uniforms[name];
  if (uniform !== undefined) uniform.value = value;
}

/**
 * Points the camera along the pose for a screen of this size and returns the lens shift
 * it used: the target lands at the shift, in normalised device units.
 */
export function aimCamera(
  camera: PerspectiveCamera,
  pose: CameraPose,
  width: number,
  height: number,
): Vec2 {
  camera.fov = pose.fov;
  camera.aspect = width / height;
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  const shift = width >= height ? pose.shiftWide : pose.shiftTall;
  // setViewOffset also refreshes the projection matrix after the fov change.
  camera.setViewOffset(
    width,
    height,
    (-shift[0] * width) / 2,
    (shift[1] * height) / 2,
    width,
    height,
  );
  return shift;
}

export function createStage(canvas: HTMLCanvasElement, settings: TierSettings): Stage {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Tone mapping stays off so the canvas background equals the CSS background.
  renderer.toneMapping = NoToneMapping;
  const scene = new Scene();
  const background = new Color("#fafaf8");
  scene.background = background;
  const camera = new PerspectiveCamera(20, 1, 0.5, 400);
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    samples: settings.antialiasSamples,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const ambient = settings.ambientOcclusion ? new GTAOPass(scene, camera, 1, 1) : null;
  if (ambient !== null) {
    ambient.updateGtaoMaterial({
      radius: 0.55,
      distanceExponent: 1.4,
      thickness: 1.3,
      scale: 1.5,
      samples: 16,
    });
    ambient.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 5,
      rings: 2,
      samples: 16,
    });
    composer.addPass(ambient);
  }
  const bloom = settings.bloom ? new UnrealBloomPass(new Vector2(1, 1), 0, 0.55, 0.8) : null;
  if (bloom !== null) composer.addPass(bloom);
  const tiltH = settings.tiltShift ? new ShaderPass(HorizontalTiltShiftShader) : null;
  const tiltV = settings.tiltShift ? new ShaderPass(VerticalTiltShiftShader) : null;
  if (tiltH !== null && tiltV !== null) {
    composer.addPass(tiltH);
    composer.addPass(tiltV);
  }
  composer.addPass(new OutputPass());
  let width = 1;
  let height = 1;
  return {
    scene,
    resize(nextWidth, nextHeight, devicePixelRatio) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      const ratio = Math.min(devicePixelRatio, settings.pixelRatioCap);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      setUniform(tiltH, "h", TILT_PIXELS / (width * ratio));
      setUniform(tiltV, "v", TILT_PIXELS / (height * ratio));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    render(pose, lighting) {
      const shift = aimCamera(camera, pose, width, height);
      // The sharp band follows the lens shift, so it stays on the subject.
      const focus = TILT_FOCUS + shift[1] / 2;
      setUniform(tiltH, "r", focus);
      setUniform(tiltV, "r", focus);
      background.set(lighting.background);
      if (ambient !== null) ambient.blendIntensity = lighting.ambientOcclusion;
      if (bloom !== null) {
        bloom.strength = lighting.bloom;
        bloom.enabled = lighting.bloom > 0;
      }
      composer.render();
    },
    dispose() {
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
