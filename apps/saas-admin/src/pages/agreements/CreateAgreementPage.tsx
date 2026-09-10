import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Alert, Button, Field, Input, SectionHeader } from "@markiro/ui";

import { createAgreement } from "./api.js";
import {
  AgreementRequisitesForm,
  EMPTY_REQUISITES,
  toRequisitesInput,
  type RequisitesDraft,
} from "./AgreementRequisitesForm.js";

export function CreateAgreementPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [counterparty, setCounterparty] = useState<RequisitesDraft>(EMPTY_REQUISITES);
  const [number, setNumber] = useState("");
  const [conclusionDate, setConclusionDate] = useState("");
  const [city, setCity] = useState("");
  const [position, setPosition] = useState("");
  const [fullName, setFullName] = useState("");
  const [authorityBasis, setAuthorityBasis] = useState("");
  const [disputeVenue, setDisputeVenue] = useState("");
  const [penaltyRatePercent, setPenaltyRatePercent] = useState("");
  const [penaltyCapPercent, setPenaltyCapPercent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const nullable = (value: string) => (value.trim() === "" ? null : value.trim());

  const create = useMutation({
    mutationFn: () =>
      createAgreement({
        ...(number.trim() === "" ? {} : { number: number.trim() }),
        ...(conclusionDate === "" ? {} : { conclusionDate }),
        ...(city.trim() === "" ? {} : { city: city.trim() }),
        counterparty: toRequisitesInput(counterparty) as never,
        signatory: {
          position: nullable(position),
          fullName: nullable(fullName),
          authorityBasis: nullable(authorityBasis),
        },
        terms: {
          disputeVenue: nullable(disputeVenue),
          penaltyRatePercent: nullable(penaltyRatePercent),
          penaltyCapPercent: nullable(penaltyCapPercent),
        },
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["platform", "agreements"] });
      void navigate(`/agreements/${result.agreement.id}`);
    },
    onError: (error: Error) => setFormError(error.message),
  });

  return (
    <section className="catalog-page">
      <SectionHeader
        eyebrow="COMMERCE / AGREEMENTS"
        title={t("agreements.createTitle")}
        description={t("agreements.createDescription")}
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          create.mutate();
        }}
      >
        <h3>{t("agreements.sections.counterparty")}</h3>
        <AgreementRequisitesForm value={counterparty} onChange={setCounterparty} />

        <h3>{t("agreements.sections.signatory")}</h3>
        <Field
          label={t("agreements.fields.signatoryPosition")}
          htmlFor="agreement-signatory-position"
        >
          <Input
            id="agreement-signatory-position"
            value={position}
            onChange={(event) => setPosition(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.signatoryName")} htmlFor="agreement-signatory-name">
          <Input
            id="agreement-signatory-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.authorityBasis")} htmlFor="agreement-authority">
          <Input
            id="agreement-authority"
            value={authorityBasis}
            onChange={(event) => setAuthorityBasis(event.target.value)}
          />
        </Field>

        <h3>{t("agreements.sections.terms")}</h3>
        <Field label={t("agreements.fields.disputeVenue")} htmlFor="agreement-venue">
          <Input
            id="agreement-venue"
            value={disputeVenue}
            onChange={(event) => setDisputeVenue(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.penaltyRate")} htmlFor="agreement-penalty-rate">
          <Input
            id="agreement-penalty-rate"
            value={penaltyRatePercent}
            placeholder="0,05"
            onChange={(event) => setPenaltyRatePercent(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.penaltyCap")} htmlFor="agreement-penalty-cap">
          <Input
            id="agreement-penalty-cap"
            value={penaltyCapPercent}
            placeholder="10"
            onChange={(event) => setPenaltyCapPercent(event.target.value)}
          />
        </Field>

        <h3>{t("agreements.sections.header")}</h3>
        <Field
          label={t("agreements.fields.number")}
          htmlFor="agreement-number"
          hint={t("agreements.fields.numberHint")}
        >
          <Input
            id="agreement-number"
            value={number}
            placeholder={t("agreements.fields.numberAuto")}
            onChange={(event) => setNumber(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.conclusionDate")} htmlFor="agreement-date">
          <Input
            id="agreement-date"
            type="date"
            value={conclusionDate}
            onChange={(event) => setConclusionDate(event.target.value)}
          />
        </Field>
        <Field label={t("agreements.fields.city")} htmlFor="agreement-city">
          <Input
            id="agreement-city"
            value={city}
            onChange={(event) => setCity(event.target.value)}
          />
        </Field>

        {formError && <Alert tone="error">{formError}</Alert>}

        <Button type="submit" disabled={create.isPending || counterparty.name.trim() === ""}>
          {t("agreements.createSubmit")}
        </Button>
      </form>
    </section>
  );
}
