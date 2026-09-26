import { Box3, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { parseHex } from "../color";
import { person } from "./figures";
import { DAY_PALETTE, Kit, NIGHT_PALETTE, ROLES } from "./kit";
import { createProduct, openCase, pallet } from "./props";
import { blankTextureFactory, createScreenTextures } from "./textures";

function isMesh(node: unknown): node is Mesh {
  return node instanceof Mesh;
}

function meshes(root: Group): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((node) => {
    if (isMesh(node)) found.push(node);
  });
  return found;
}

function expectColour(actual: string, expected: string): void {
  const a = parseHex(`#${actual}`);
  const b = parseHex(expected);
  a.forEach((channel, index) => {
    expect(Math.abs(channel - (b[index] ?? 0))).toBeLessThan(2 / 255);
  });
}

describe("film model kit", () => {
  it("shares one material per palette role and recolours it for the night", () => {
    const kit = new Kit();
    const wall = kit.material("wall");
    expect(kit.material("wall")).toBe(wall);
    expectColour(wall.color.getHexString(), DAY_PALETTE.wall);
    kit.setNightMix(1);
    expectColour(wall.color.getHexString(), NIGHT_PALETTE.wall);
    for (const role of ROLES) expect(NIGHT_PALETTE[role]).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it("stands blocks on their base", () => {
    const kit = new Kit();
    const block = kit.block(new Group(), 1, 2, 1, "wall", 3, 0.5, -1);
    expect(block.position.toArray()).toEqual([3, 1.5, -1]);
  });

  it("builds every product with a code plate", () => {
    const kit = new Kit();
    for (const kind of ["bottle", "jar", "can"] as const) {
      const product = createProduct(kit, kind);
      expect(product.code.name).toBe("code");
      expect(product.group.children).toContain(product.code);
    }
  });

  it("fills an open case with verified products and stacks a pallet", () => {
    const kit = new Kit();
    const root = new Group();
    const packing = openCase(kit, root, 0, 0, 0, 6);
    expect(packing.products).toHaveLength(6);
    const codes = meshes(packing.group).filter((mesh) => mesh.name === "code");
    expect(codes).toHaveLength(6);
    expect(codes.every((mesh) => mesh.material === kit.signals.verified)).toBe(true);
    expect(pallet(kit, root, 0, 0, 0, 8, new MeshBasicMaterial()).cases).toHaveLength(8);
  });

  it("keeps the pallet label clear of the case labels on the pallet front", () => {
    const kit = new Kit();
    const root = new Group();
    const { group } = pallet(kit, root, 0, 0, 0, 8, new MeshBasicMaterial());
    root.updateMatrixWorld(true);
    const tag = group.getObjectByName("pallet-label");
    expect(tag).toBeDefined();
    if (tag === undefined) return;
    const tagBox = new Box3().setFromObject(tag);
    const front = meshes(group).filter(
      (mesh) =>
        mesh.name === "label" &&
        mesh.getWorldDirection(new Vector3()).z > 0.99 &&
        mesh.getWorldPosition(new Vector3()).z > 0.4,
    );
    expect(front).toHaveLength(4);
    for (const label of front) {
      const box = new Box3().setFromObject(label);
      const covered =
        box.min.x < tagBox.max.x &&
        tagBox.min.x < box.max.x &&
        box.min.y < tagBox.max.y &&
        tagBox.min.y < box.max.y;
      expect(covered).toBe(false);
    }
  });

  it("dresses people in coats and gives the handheld worker a green screen", () => {
    const kit = new Kit();
    const root = new Group();
    const worker = person(kit, root, 0, 0, 0, "device");
    const visitor = person(kit, root, 1, 0, 0, "badge");
    expect(worker.name).toBe("person");
    expect(meshes(worker).find((mesh) => mesh.name === "handheld-screen")?.material).toBe(
      kit.signals.verified,
    );
    expect(meshes(visitor).some((mesh) => mesh.name === "badge")).toBe(true);
    expect(meshes(worker).length).toBeGreaterThan(10);
  });

  it("prepares day and night screens for every kiosk step", () => {
    const screens = createScreenTextures(blankTextureFactory);
    expect(screens.station(false)).not.toBe(screens.station(true));
    const kiosk = new Set(
      [0, 1, 2, 3].flatMap((step) => [screens.kiosk(false, step), screens.kiosk(true, step)]),
    );
    expect(kiosk.size).toBe(8);
    expect(screens.kiosk(false, 9)).toBe(screens.kiosk(false, 3));
  });
});
