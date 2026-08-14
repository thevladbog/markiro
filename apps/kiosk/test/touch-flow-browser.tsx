import "@markiro/ui/styles.css";
import "../src/kiosk.css";
import "../src/i18n/index.js";

import { ThemeProvider } from "@markiro/ui";
import { createRoot } from "react-dom/client";

import type { CreateOrderResultDto, KioskBootstrapDto } from "../src/api/types.js";
import { Cart } from "../src/screens/Cart.js";
import { Confirmation } from "../src/screens/Confirmation.js";
import { Done } from "../src/screens/Done.js";
import { OperationChoice } from "../src/screens/OperationChoice.js";
import { WriteoffReason } from "../src/screens/WriteoffReason.js";
import type { CartState, KioskCartLine } from "../src/session/cart.js";
import { KioskLayout } from "../src/ui/KioskLayout.js";
import { StatusStrip } from "../src/ui/StatusStrip.js";

const EMPLOYEE_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const GTIN = "04600682000013";
const SSCC = "346006820000000021";
const fixtureScreen = new URLSearchParams(window.location.search).get("screen") ?? "cart";
const reasons = [
  "Брак",
  "Бой",
  "Просрочка",
  "Дегустация для очень длинного названия причины списания",
  "Инвентаризация",
  "Другое",
].map((name, index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
  name,
}));

const bootstrap: KioskBootstrapDto = {
  generatedAt: new Date().toISOString(),
  subscription: {
    access: "managed",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2027-08-31T00:00:00.000Z",
  },
  branding: { organizationName: "ООО Маяк", logoUrl: null, logoRevision: null },
  pickupPolicy: { limitsEnabled: false },
  config: { dayLimitPerEmployee: 999, showPrices: true },
  badgeSalt: "fwGrIt01vwgBxxDlhqLVRQ==",
  reasons,
  products: [
    {
      id: PRODUCT_ID,
      gtin14: GTIN,
      name: "Молоко ультрапастеризованное 3,2% с очень длинным названием позиции",
      unitPrice: "89.90",
      egaisCode: null,
    },
  ],
  employees: [
    {
      id: EMPLOYEE_ID,
      fullName: "Смирнов Алексей Александрович",
      role: null,
      badgeHash: null,
      limitMode: "unlimited",
      dayLimit: 999,
      canWriteoff: true,
      takenTodayElsewhere: 0,
    },
  ],
  operators: [],
};

const lines: KioskCartLine[] = Array.from({ length: 100 }, (_, index) => {
  if (index === 0) {
    return {
      kind: "box",
      boxId: "44444444-4444-4444-8444-444444444444",
      sscc: SSCC,
      productId: PRODUCT_ID,
      name: bootstrap.products[0]!.name,
      bottleCount: 12,
      unitPrice: "89.90",
      contentKeys: Array.from({ length: 12 }, (_unused, member) => `box-member-${member}`),
      registryVersion: "7",
    };
  }
  const serial = `SERIAL-${String(index).padStart(3, "0")}`;
  return {
    kind: "km",
    rawKm: `01${GTIN}21${serial}`,
    kmKey: `01${GTIN}21${serial}`,
    gtin14: GTIN,
    serial,
    productId: PRODUCT_ID,
    name: bootstrap.products[0]!.name,
    unitPrice: "89.90",
    bottleCount: 1,
  };
});

const buyCart: CartState = {
  lines,
  reason: "buy",
  writeoffReasonId: null,
  notice: null,
};
const writeoffCart: CartState = {
  ...buyCart,
  reason: "writeoff",
  writeoffReasonId: reasons[0]!.id,
};

const accepted: CreateOrderResultDto = {
  orderNo: "ORD-26-0042",
  status: "pending",
  itemCount: 111,
  conflicts: [],
  boxConflicts: [],
  acceptedBoxes: [{ sscc: SSCC, bottleCount: 12 }],
};
const rejected: CreateOrderResultDto = {
  orderNo: "",
  status: "pending",
  itemCount: 0,
  conflicts: [{ rawKm: lines[1]!.kind === "km" ? lines[1]!.rawKm : "", reason: "over_limit" }],
  boxConflicts: [{ sscc: SSCC, bottleCount: 12, reason: "over_limit" }],
  acceptedBoxes: [],
};
const partial: CreateOrderResultDto = {
  ...accepted,
  itemCount: 99,
  boxConflicts: [{ sscc: SSCC, bottleCount: 12, reason: "over_limit" }],
  acceptedBoxes: [],
};

function FixtureScreen(): React.JSX.Element {
  const screen = fixtureScreen;
  if (screen === "operation") {
    return (
      <OperationChoice
        writeoffAvailable
        onChoose={() => undefined}
        onBack={() => undefined}
        onCancel={() => undefined}
      />
    );
  }
  if (screen === "reason") {
    return (
      <WriteoffReason
        reasons={reasons}
        selectedId={reasons[0]!.id}
        onSelect={() => undefined}
        onContinue={() => undefined}
        onBack={() => undefined}
        onCancel={() => undefined}
      />
    );
  }
  if (screen === "confirmation") {
    return (
      <Confirmation
        cart={writeoffCart}
        showPrices
        reasonName={reasons[0]!.name}
        pending={false}
        onBack={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );
  }
  if (
    screen === "accepted" ||
    screen === "queued" ||
    screen === "rejected" ||
    screen === "partial"
  ) {
    const result =
      screen === "queued"
        ? null
        : screen === "rejected"
          ? rejected
          : screen === "partial"
            ? partial
            : accepted;
    return <Done result={result} cart={buyCart} showPrices onReset={() => undefined} />;
  }
  return (
    <Cart
      employee={{ id: EMPLOYEE_ID, fullName: "Смирнов Алексей Александрович" }}
      bootstrap={bootstrap}
      alreadyTakenToday={0}
      initialState={buyCart}
      onScan={() => undefined}
      onSubmit={() => undefined}
      onNotMe={() => undefined}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <ThemeProvider defaultTheme="dark">
    <KioskLayout
      status={
        <StatusStrip online={fixtureScreen !== "queued"} age="fresh" ageMs={0} quarantined={0} />
      }
    >
      <FixtureScreen />
    </KioskLayout>
  </ThemeProvider>,
);
