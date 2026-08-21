const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const requireFromLegalDocuments = createRequire(
  path.resolve(__dirname, "../../../packages/legal-documents/package.json"),
);
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Header,
  Footer,
  AlignmentType,
  BorderStyle,
  Tab,
  TabStopType,
  TabStopPosition,
  PageNumber,
  LineRuleType,
} = requireFromLegalDocuments("docx");

const INK = "17161A";
const FG2 = "45433E";
const FG3 = "6B6862";
const LINE = "C9C6BD";
const ACCENT = "0FAF56";
const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";

const mm = (v) => Math.round(v * 56.6929); // mm -> DXA

const lockup = fs.readFileSync(path.join(__dirname, "assets/lockup.png"));
const lockupMini = fs.readFileSync(path.join(__dirname, "assets/lockup-mini.png"));
// Канон MKR-BRD-01: оператор из packages/legal-documents/src/operator.ts
const OPERATOR_LINE =
  "Богатырев Владислав Сергеевич · +7 934 355-14-90 · hello@v-b.tech · markiro.app";
const OPERATOR_ADDRESS =
  "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26";

const ruleBorder = {
  bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 },
};

const firstHeader = new Header({
  children: [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new ImageRun({ type: "png", data: lockup, transformation: { width: 160, height: 42 } }),
        new TextRun({ children: [new Tab()], text: "" }),
        new TextRun({ text: "markiro.app", font: MONO, size: 15, color: INK }),
        new TextRun({ break: 1, text: "", font: MONO, size: 15 }),
        new TextRun({ children: [new Tab()], text: "" }),
        new TextRun({ text: "hello@v-b.tech", font: MONO, size: 15, color: FG3 }),
      ],
    }),
    new Paragraph({
      spacing: { before: 160, after: 240 },
      border: ruleBorder,
      children: [new TextRun({ text: "■", font: SANS, size: 10, color: ACCENT })],
    }),
  ],
});

const defaultHeader = new Header({
  children: [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new ImageRun({ type: "png", data: lockupMini, transformation: { width: 93, height: 24 } }),
        new TextRun({ children: [new Tab()], text: "" }),
        new TextRun({ text: "markiro.app", font: MONO, size: 13, color: FG3 }),
      ],
    }),
    new Paragraph({
      spacing: { before: 100, after: 200 },
      border: ruleBorder,
      children: [new TextRun({ text: "■", font: SANS, size: 8, color: ACCENT })],
    }),
  ],
});

const footerLine = (texts, right) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    spacing: { after: 40 },
    children: [
      new TextRun({ text: texts, font: SANS, size: 13, color: FG3 }),
      ...(right ? [new TextRun({ children: [new Tab()] }), ...right] : []),
    ],
  });

const mkFooter = () =>
  new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "E0DED7", space: 4 } },
        spacing: { after: 80 },
        children: [],
      }),
      footerLine(OPERATOR_LINE, [
        new TextRun({
          children: ["стр. ", PageNumber.CURRENT],
          font: MONO,
          size: 13,
          color: FG3,
        }),
      ]),
      footerLine(OPERATOR_ADDRESS),
    ],
  });

const body = [
  new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { after: 480, line: 360, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({ text: "Генеральному директору", font: SANS, size: 22, color: FG2 }),
      new TextRun({ break: 1, text: "ООО «________________»", font: SANS, size: 22, color: FG2 }),
      new TextRun({ break: 1, text: "________________________", font: SANS, size: 22, color: FG2 }),
    ],
  }),
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    spacing: { after: 360 },
    children: [
      new TextRun({
        text: "Исх. № ________ от «___» ____________ 20___ г.",
        font: MONO,
        size: 18,
        color: FG2,
      }),
      new TextRun({ children: [new Tab()] }),
      new TextRun({ text: "г. ____________", font: MONO, size: 18, color: FG2 }),
    ],
  }),
  new Paragraph({
    spacing: { after: 240 },
    children: [
      new TextRun({
        text: "Уважаемый ____________________!",
        font: SANS,
        size: 22,
        bold: true,
        color: INK,
      }),
    ],
  }),
  new Paragraph({
    spacing: { after: 240, line: 360, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({
        text: "Текст письма набирается шрифтом IBM Plex Sans, кегль 11 pt, межстрочный интервал 1,5. Абзацы разделяются пустой строкой, абзацный отступ не используется. Числа, номера кодов и идентификаторы внутри текста выделяются шрифтом IBM Plex Mono.",
        font: SANS,
        size: 22,
        color: FG2,
      }),
    ],
  }),
  new Paragraph({
    spacing: { before: 600 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: "Оператор платформы Маркиро", font: SANS, size: 22, color: INK }),
      new TextRun({ children: [new Tab()] }),
      new TextRun({
        text: "_______________ / Богатырев В. С. /",
        font: SANS,
        size: 22,
        color: INK,
      }),
    ],
  }),
];

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: SANS, size: 22, color: INK } },
    },
  },
  sections: [
    {
      properties: {
        titlePage: true,
        page: {
          margin: { top: mm(15), bottom: mm(15), left: mm(20), right: mm(15) },
        },
      },
      headers: { first: firstHeader, default: defaultHeader },
      footers: { first: mkFooter(), default: mkFooter() },
      children: body,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "markiro-blank.docx");
  fs.writeFileSync(outputPath, buf);
  console.log(`written ${outputPath}`);
});
