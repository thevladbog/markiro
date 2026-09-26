import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { BELT, CASE_CAPACITY, PALLET_CAPACITY, QUEUE_TILES } from "../animations";
import { buildDistrict } from "./district";
import { Kit, ROLES } from "./kit";
import { blankTextureFactory, createScreenTextures } from "./textures";

const GREEN_NAMES = new Set([
  "code",
  "scanner-lamp",
  "scan-line",
  "printer-led",
  "handheld-screen",
  "mast-lamp",
  "kiosk-ok",
]);

function isMesh(node: unknown): node is Mesh {
  return node instanceof Mesh;
}

function build() {
  const kit = new Kit();
  const root = new Group();
  const handles = buildDistrict(kit, root, createScreenTextures(blankTextureFactory));
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if (isMesh(node)) meshes.push(node);
  });
  return { kit, root, handles, meshes };
}

describe("film district", () => {
  it("exposes every animated part", () => {
    const { handles } = build();
    expect(handles.belt).toHaveLength(BELT.count);
    for (const slot of handles.belt) {
      expect(Object.keys(slot.products).sort()).toEqual(["bottle", "can", "jar"]);
      expect(slot.codes).toHaveLength(3);
    }
    expect(handles.caseProducts).toHaveLength(CASE_CAPACITY);
    expect(handles.palletCases).toHaveLength(PALLET_CAPACITY);
    expect(handles.queueTiles).toHaveLength(QUEUE_TILES);
    expect(handles.lampSpots).toHaveLength(4);
    expect(handles.contactShadow.transparent).toBe(true);
  });

  it("keeps green for passed codes, indicators and screens", () => {
    const { kit, meshes } = build();
    const green = meshes.filter((mesh) => mesh.material === kit.signals.verified);
    expect(green.length).toBeGreaterThan(0);
    for (const mesh of green) expect(GREEN_NAMES.has(mesh.name), mesh.name).toBe(true);
  });

  it("paints lit surfaces only from the palette", () => {
    const { meshes } = build();
    const allowed = new Set<string>([...ROLES, "label", "window"]);
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial) {
          expect(allowed.has(material.name), material.name).toBe(true);
        }
      }
    }
  });

  it("builds three producers and their people", () => {
    const { root } = build();
    for (const name of ["district", "plant", "brewery", "cosmetics", "kiosk", "office", "van"]) {
      expect(root.getObjectByName(name), name).toBeDefined();
    }
    let people = 0;
    root.traverse((node) => {
      if (node.name === "person") people += 1;
    });
    expect(people).toBeGreaterThanOrEqual(7);
  });

  it("holds the handheld in front of a transport label, not inside a case", () => {
    const { root } = build();
    root.updateMatrixWorld(true);
    const device = root.getObjectByName("handheld-screen")?.parent ?? null;
    expect(device).not.toBeNull();
    if (device === null) return;
    const deviceBox = new Box3().setFromObject(device);
    const cases =
      root.getObjectByName("pallet")?.children.filter((child) => child.name === "closed-case") ??
      [];
    expect(cases).toHaveLength(PALLET_CAPACITY);
    for (const box of cases) {
      expect(new Box3().setFromObject(box).intersectsBox(deviceBox)).toBe(false);
    }
    const labels: Mesh[] = [];
    for (const box of cases) {
      box.traverse((node) => {
        if (isMesh(node) && node.name === "label") labels.push(node);
      });
    }
    expect(labels).toHaveLength(PALLET_CAPACITY * 2);
    const centre = deviceBox.getCenter(new Vector3());
    const nearest = Math.min(
      ...labels.map((label) => label.getWorldPosition(new Vector3()).distanceTo(centre)),
    );
    expect(nearest).toBeLessThan(0.3);
  });
});
