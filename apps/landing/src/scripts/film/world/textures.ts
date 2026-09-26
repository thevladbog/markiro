import { CanvasTexture, SRGBColorSpace, Texture } from "three";

export type Draw = (context: CanvasRenderingContext2D, width: number, height: number) => void;

export interface TextureFactory {
  create(width: number, height: number, draw: Draw): Texture;
}

export const canvasTextureFactory: TextureFactory = {
  create(width, height, draw) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context !== null) draw(context, width, height);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  },
};

/** For tests: textures without pixels. */
export const blankTextureFactory: TextureFactory = {
  create: () => new Texture(),
};

export interface ScreenTextures {
  readonly label: Texture;
  readonly contactShadow: Texture;
  station(dark: boolean): Texture;
  kiosk(dark: boolean, step: number): Texture;
}

const GREEN = "#3DDC7A";

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

const drawLabel: Draw = (g, width) => {
  const random = seeded(7);
  g.fillStyle = "#FFFFFF";
  g.fillRect(0, 0, width, 176);
  g.fillStyle = "#17161A";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 || y === 7 || random() > 0.5) g.fillRect(16 + x * 7, 14 + y * 7, 7, 7);
    }
  }
  for (let row = 0; row < 5; row += 1) g.fillRect(92, 18 + row * 12, 60 + random() * 90, 5);
  let x = 16;
  while (x < width - 18) {
    const bar = 2 + Math.floor(random() * 5);
    g.fillRect(x, 100, bar, 56);
    x += bar + 2 + Math.floor(random() * 4);
  }
};

function drawStation(dark: boolean): Draw {
  return (g, width) => {
    g.fillStyle = dark ? "#1C1B21" : "#FFFFFF";
    g.fillRect(0, 0, width, 320);
    g.fillStyle = dark ? "#2E2D33" : "#17161A";
    g.fillRect(0, 0, width, 26);
    g.fillStyle = dark ? "#45444B" : "#E0DED7";
    g.fillRect(24, 50, 120, 150);
    for (let row = 0; row < 4; row += 1) g.fillRect(24, 214 + row * 18, 90 + (row % 2) * 30, 8);
    for (let cell = 0; cell < 10; cell += 1) {
      const x = 172 + (cell % 5) * 62;
      const y = 60 + Math.floor(cell / 5) * 70;
      if (cell < 7) {
        g.fillStyle = GREEN;
        g.fillRect(x, y, 52, 56);
      } else {
        g.strokeStyle = dark ? "#5B5952" : "#C9C6BD";
        g.lineWidth = 3;
        g.strokeRect(x + 1.5, y + 1.5, 49, 53);
      }
    }
    g.fillStyle = dark ? "#2E2D33" : "#F0EFEA";
    g.fillRect(172, 222, 302, 14);
    g.fillStyle = GREEN;
    g.fillRect(172, 222, 212, 14);
  };
}

function drawKiosk(dark: boolean, step: number): Draw {
  return (g, width, height) => {
    g.fillStyle = dark ? "#1C1B21" : "#FFFFFF";
    g.fillRect(0, 0, width, height);
    g.fillStyle = dark ? "#2E2D33" : "#17161A";
    g.fillRect(0, 0, width, 30);
    g.fillStyle = dark ? "#45444B" : "#E0DED7";
    g.fillRect(24, 56, 96, 96);
    for (let row = 0; row < 3; row += 1) g.fillRect(136, 60 + row * 22, 90 - row * 14, 10);
    for (let row = 0; row < 3; row += 1) {
      g.fillStyle = row < step ? GREEN : dark ? "#45444B" : "#E0DED7";
      g.fillRect(24, 180 + row * 34, width - 48, 22);
    }
    g.fillStyle = step >= 3 ? GREEN : dark ? "#2E2D33" : "#F0EFEA";
    g.fillRect(24, 300, width - 48, 36);
  };
}

const drawContactShadow: Draw = (g, width, height) => {
  g.filter = "blur(30px)";
  g.fillStyle = "#000000";
  g.beginPath();
  g.roundRect(64, 120, width - 128, height - 240, 36);
  g.fill();
};

export function createScreenTextures(factory: TextureFactory): ScreenTextures {
  const label = factory.create(256, 176, drawLabel);
  const contactShadow = factory.create(512, 512, drawContactShadow);
  const stations = [
    factory.create(512, 320, drawStation(false)),
    factory.create(512, 320, drawStation(true)),
  ];
  const kiosks = [false, true].map((dark) =>
    [0, 1, 2, 3].map((step) => factory.create(256, 360, drawKiosk(dark, step))),
  );
  return {
    label,
    contactShadow,
    station: (dark) => stations[dark ? 1 : 0] ?? label,
    kiosk: (dark, step) => {
      const row = kiosks[dark ? 1 : 0] ?? [];
      return row[Math.max(0, Math.min(3, step))] ?? label;
    },
  };
}
