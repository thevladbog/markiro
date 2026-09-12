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
  ]) {
    for (const [width, height] of sizes) {
      const id = `${category.id}/${kind}-${width}x${height}`;
      await mkdir(`${root}${category.id}`, { recursive: true });
      await writeFile(`${root}${id}.zpl`, (kind === "unit" ? unit : box)(category, width, height));
      manifest.push({
        id,
        category: category.title,
        group: category.group,
        purpose: kind === "unit" ? "product_duplicate" : "box",
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
          sscc: kind === "unit" ? "" : "146006820000000010",
          "shift.no": "2026-000042",
          date: "11.09.2026",
          expiry: "10.09.2027",
          qty: kind === "unit" ? "1" : "12",
          // 06d added `qty.boxes` to the label field set. A box or unit
          // label holds no boxes, so it is empty exactly as `boxLabelData`
          // leaves it -- a "0" would print as «0 кор.» on any template
          // that binds the field.
          "qty.boxes": "",
          operator: "Оператор",
          "counterparty.name": "",
        },
      });
    }
  }
}
await writeFile(`${root}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${manifest.length} import sources.`);
