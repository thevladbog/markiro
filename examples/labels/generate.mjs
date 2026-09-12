import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dpi = 203;
const dots = (mm) => Math.round((mm * dpi) / 25.4);
const categories = [
  {
    id: "juices",
    group: 23,
    title: "Соки",
    heading: "СОКИ",
    compact: "СОК",
    product: "Сок яблочный, 1 л",
  },
  {
    id: "vegetable-oils",
    group: 33,
    title: "Растительные масла",
    heading: "РАСТИТЕЛЬНЫЕ МАСЛА",
    compact: "МАСЛО",
    product: "Масло подсолнечное, 1 л",
  },
  {
    id: "cosmetics",
    group: 35,
    title: "Косметика",
    heading: "КОСМЕТИКА",
    compact: "КОСМ.",
    product: "Крем для рук, 75 мл",
  },
];

function layout(width, height) {
  const commands = ["^XA", `^PW${dots(width)}`, `^LL${dots(height)}`];
  return {
    text(x, y, pt, value, maxWidth, align = "L") {
      const font = Math.round((pt * dpi) / 72);
      commands.push(
        `^FO${dots(x)},${dots(y)}^A0N,${font},${font}^FB${dots(maxWidth)},1,0,${align},0^FD${value}^FS`,
      );
    },
    rule(x, y, width) {
      commands.push(`^FO${dots(x)},${dots(y)}^GB${dots(width)},0,${dots(0.25)}^FS`);
    },
    matrix(x, y, size) {
      // Markiro's duplicate import model uses the full symbol square here.
      // This source is imported into Markiro, never sent directly to a printer.
      commands.push(`^FO${dots(x)},${dots(y)}^BXN,${dots(size)}^FD{{km.code}}^FS`);
    },
    sscc(y, height) {
      const moduleDots = Math.max(2, Math.floor(dots(width - 8) / 176));
      const symbolWidth = (156 * moduleDots * 25.4) / dpi;
      commands.push(
        `^FO${dots((width - symbolWidth) / 2)},${dots(y)}^BY${moduleDots}^BCN,${dots(height)},N,N,N^FD{{sscc}}^FS`,
      );
    },
    finish() {
      return [...commands, "^XZ", ""].join("\n");
    },
  };
}

function unit(category, width, height) {
  const l = layout(width, height);
  if (width === 30) {
    l.matrix(1, 1, 18);
    l.text(20, 1, 4, category.compact, 9);
    l.text(20, 4, 4, "Изг.:", 9);
    l.text(20, 6.5, 4, "{{date}}", 9);
    l.text(20, 11, 4, "Годен:", 9);
    l.text(20, 13.5, 4, "{{expiry}}", 9);
  } else if (width === 58) {
    l.text(2, 2, 6, category.heading, 54);
    l.text(2, 6, 9, "{{product.printName}}", 54);
    l.rule(2, 11.5, 54);
    l.text(2, 14, 5, "Изготовлено", 27);
    l.text(2, 17.5, 7, "{{date}}", 27);
    l.text(2, 23, 5, "Годен до", 27);
    l.text(2, 26.5, 7, "{{expiry}}", 27);
    l.text(2, 33.5, 5, "{{product.gtin}}", 27);
    l.matrix(31, 13, 24);
  } else {
    l.text(4, 4, 9, category.heading, 67);
    l.text(4, 12, 13, "{{product.printName}}", 67);
    l.rule(4, 22, 67);
    l.text(4, 26, 7, "GTIN", 67);
    l.text(4, 31, 11, "{{product.gtin}}", 67);
    l.text(4, 41, 7, "Изготовлено", 32);
    l.text(39, 41, 7, "Годен до", 32);
    l.text(4, 47, 10, "{{date}}", 32);
    l.text(39, 47, 10, "{{expiry}}", 32);
    l.text(4, 59, 7, "Смена", 67);
    l.text(4, 65, 10, "{{shift.no}}", 67);
    l.matrix(19.5, 78, 36);
  }
  return l.finish();
}

function box(category, width, height) {
  const l = layout(width, height);
  if (width === 58) {
    l.text(2, 1.5, 5, category.heading, 54);
    l.text(2, 5, 8, "{{product.printName}}", 54);
    l.rule(2, 10, 54);
    l.text(2, 11.5, 4.5, "Изготовлено", 18);
    l.text(22, 11.5, 4.5, "Годен до", 18);
    l.text(42, 11.5, 4.5, "В коробе", 14);
    l.text(2, 15, 6, "{{date}}", 18);
    l.text(22, 15, 6, "{{expiry}}", 18);
    l.text(42, 15, 6, "{{qty}}", 14);
    l.text(2, 21, 5, "GTIN", 8);
    l.text(12, 21, 5, "{{product.gtin}}", 44);
    l.sscc(26, 7);
    l.text(2, 35, 6, "{{sscc}}", 54, "C");
  } else {
    const half = width / 2;
    const column = half - 8;
    l.text(4, 4, 9, category.heading, width - 8);
    l.text(4, height * 0.1, 13, "{{product.printName}}", width - 8);
    l.rule(4, height * 0.2, width - 8);
    l.text(4, height * 0.25, 7, "Изготовлено", column);
    l.text(half, height * 0.25, 7, "Годен до", column);
    l.text(4, height * 0.305, 10, "{{date}}", column);
    l.text(half, height * 0.305, 10, "{{expiry}}", column);
    l.text(4, height * 0.43, 7, "В коробе", column);
    l.text(half, height * 0.43, 7, "Смена", column);
    l.text(4, height * 0.485, 10, "{{qty}}", column);
    l.text(half, height * 0.485, 10, "{{shift.no}}", column);
    l.text(4, height * 0.6, 7, "GTIN", width - 8);
    l.text(4, height * 0.655, 10, "{{product.gtin}}", width - 8);
    l.sscc(height * 0.76, height * 0.12);
    l.text(4, height * 0.91, 10, "{{sscc}}", width - 8, "C");
  }
  return l.finish();
}

/**
 * A pallet label (06d), and the two counts are what make it one.
 *
 * `qty.boxes` and `qty` lead the layout, side by side and equally large:
 * a goods-in clerk counts boxes off the stack and checks them against the
 * label, and the units figure is what the next system reconciles. They carry
 * «кор.» and «шт.» from the shared display formatter, so the pair stays
 * unambiguous even where a caption is missed.
 *
 * Type scales with the media rather than staying fixed: a 100 mm label is read
 * at arm's length and an A5 one from a forklift, so `s` grows the whole scale
 * with the width instead of leaving A5 with 100 mm type surrounded by white.
 */
function pallet(category, width, height) {
  const l = layout(width, height);
  const half = width / 2;
  const column = half - 8;
  const inner = width - 8;
  const s = width / 100;
  l.text(4, height * 0.028, 9 * s, `ПАЛЛЕТА · ${category.heading}`, inner);
  l.text(4, height * 0.085, 14 * s, "{{product.printName}}", inner);
  l.rule(4, height * 0.165, inner);
  l.text(4, height * 0.195, 7 * s, "Коробов", column);
  l.text(half, height * 0.195, 7 * s, "Единиц", column);
  l.text(4, height * 0.235, 16 * s, "{{qty.boxes}}", column);
  l.text(half, height * 0.235, 16 * s, "{{qty}}", column);
  l.text(4, height * 0.33, 7 * s, "Изготовлено", column);
  l.text(half, height * 0.33, 7 * s, "Годен до", column);
  l.text(4, height * 0.37, 11 * s, "{{date}}", column);
  l.text(half, height * 0.37, 11 * s, "{{expiry}}", column);
  l.text(4, height * 0.46, 7 * s, "Смена", column);
  l.text(half, height * 0.46, 7 * s, "GTIN", column);
  l.text(4, height * 0.5, 11 * s, "{{shift.no}}", column);
  l.text(half, height * 0.5, 11 * s, "{{product.gtin}}", column);
  l.rule(4, height * 0.59, inner);
  l.sscc(height * 0.66, height * 0.15);
  l.text(4, height * 0.85, 12 * s, "{{sscc}}", inner, "C");
  return l.finish();
}

const LAYOUTS = { unit, box, pallet };

/**
 * The demonstration values each kind carries. Synthetic, never production.
 *
 * The SSCCs differ in their FIRST digit on purpose: Markiro cuts box serials
 * from extension digit 0 and pallet serials from 1 (`BOX_EXTENSION_DIGIT` /
 * `PALLET_EXTENSION_DIGIT` in `apps/api/src/modules/sscc/sscc.service.ts`),
 * and those spaces must never interleave. A preview is the one place a reader
 * sees what a real SSCC looks like, so showing a box with a pallet-range
 * number would teach the wrong shape.
 *
 * `qty.boxes` is empty for a unit and a box and set only for a pallet: neither
 * of the first two holds boxes, and a "0" would print as «0 кор.» on any
 * template that binds the field. The pallet's own `qty` is the total across
 * its boxes (24 × 12), not one box's count.
 */
const DEMO = {
  unit: { sscc: "", qty: "1", "qty.boxes": "" },
  box: { sscc: "046006820000000013", qty: "12", "qty.boxes": "" },
  pallet: { sscc: "146006820000000027", qty: "288", "qty.boxes": "24" },
};

const manifest = [];
for (const category of categories) {
  for (const [kind, sizes] of [
    [
      "unit",
      [
        [30, 20],
        [58, 40],
        [75, 120],
      ],
    ],
    [
      "box",
      [
        [58, 40],
        [75, 120],
        [100, 100],
        [100, 150],
      ],
    ],
    // No small format here, unlike boxes: a pallet label is read across an
    // aisle, and 148 × 210 is the A5 the GS1 logistic label is cut to.
    [
      "pallet",
      [
        [100, 100],
        [100, 150],
        [148, 210],
      ],
    ],
  ]) {
    for (const [width, height] of sizes) {
      const id = `${category.id}/${kind}-${width}x${height}`;
      await mkdir(`${root}${category.id}`, { recursive: true });
      await writeFile(`${root}${id}.zpl`, LAYOUTS[kind](category, width, height));
      manifest.push({
        id,
        category: category.title,
        group: category.group,
        purpose: kind === "unit" ? "product_duplicate" : kind,
        widthMm: width,
        heightMm: height,
        importDpi: dpi,
        source: `${id}.zpl`,
        preview: `${id}.png`,
        sampleData: {
          "product.name": category.product,
          "product.printName": category.product,
          "product.gtin": "04600000000015",
          "product.egais": "",
          "km.code": "010460000000001521DEMO-LABEL-42\u001d93Abcd",
          "shift.no": "2026-000042",
          date: "11.09.2026",
          expiry: "10.09.2027",
          ...DEMO[kind],
          operator: "Оператор",
          "counterparty.name": "",
        },
      });
    }
  }
}
await writeFile(`${root}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${manifest.length} import sources.`);
