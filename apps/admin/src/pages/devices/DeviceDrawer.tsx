import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Drawer, Input, Select } from "@markiro/ui";
import { useLines } from "../shifts/api.js";
import { useCreateKiosk, useCreateStation, type DeviceType } from "./api.js";

export function DeviceDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(); const [type, setType] = useState<DeviceType>("station"); const [name, setName] = useState(""); const [place, setPlace] = useState(""); const [stage, setStage] = useState<"create" | "code">("create");
  const lines = useLines(); const station = useCreateStation(); const kiosk = useCreateKiosk();
  const submit = async () => { if (type === "station") await station.mutateAsync({ name, lineId: place || null }); else await kiosk.mutateAsync({ name, location: place || null, dayLimitPerEmployee: 5, showPrices: true }); setStage("code"); };
  const close = () => { setStage("create"); setName(""); setPlace(""); onClose(); };
  return <Drawer open={open} title={t(stage === "create" ? "pages.devices.drawer.title" : "pages.devices.drawer.codeTitle")} onClose={close} closeLabel={t("common.close")} footer={stage === "create" ? <><Button variant="secondary" onClick={close}>{t("pages.devices.cancel")}</Button><Button loading={station.isPending || kiosk.isPending} disabled={!name.trim()} onClick={() => void submit()}>{t("pages.devices.create")}</Button></> : <Button onClick={close}>{t("pages.devices.done")}</Button>}>
    {stage === "create" ? <div style={{ display: "flex", flexDirection: "column", gap: 16 }}><Select label={t("pages.devices.typeLabel")} value={type} onChange={(value) => setType(value as DeviceType)} options={[{ value: "station", label: t("pages.devices.type.station") }, { value: "kiosk", label: t("pages.devices.type.kiosk") }]} /><Input label={t("pages.devices.nameLabel")} value={name} onChange={(event) => setName(event.target.value)} />{type === "station" ? <Select label={t("pages.devices.lineLabel")} value={place} onChange={setPlace} options={[{ value: "", label: t("pages.devices.noLine") }, ...(lines.data ?? []).map((line) => ({ value: line.id, label: line.name }))]} /> : <Input label={t("pages.devices.locationLabel")} value={place} onChange={(event) => setPlace(event.target.value)} />}</div> : <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>{t("pages.devices.drawer.codePending")}</p>}
  </Drawer>;
}
