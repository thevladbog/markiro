import type { LegalBlock } from "../types.js";
import {
  agreementDate,
  agreementField,
  isSoleProprietorOrIndividual,
  type AgreementSignatory,
  type PartyRequisites,
  type TenantAgreementFields,
} from "./tenant-agreement-fields.js";
import { buildRuAgreementSections, type AgreementSection } from "./tenant-agreement-ru.js";

const CONTRACTOR_DEFAULT_NAME = "Sole Proprietor Vladislav Sergeevich Bogatyrev";

const SIGNATURE_ROWS = [
  [CONTRACTOR_DEFAULT_NAME, "[position, full name]"],
  ["________________ / V. S. Bogatyrev /", "________________ / [full name] /"],
  ["Date: [date of signature]", "Date: [date of signature]"],
] as const;

const SIGNATURES = {
  kind: "table",
  columns: ["Contractor / Licensor", "Customer / Licensee"],
  rows: SIGNATURE_ROWS,
} as const satisfies LegalBlock;

// 152-FZ vocabulary, not GDPR: the Customer is the "operator" and the
// Contractor processes on its instruction. "Operator" here is the data
// operator, never the Markiro platform operator.
const PROCESSING_SIGNATURES = {
  kind: "table",
  columns: ["Processor — the Contractor", "Operator — the Customer"],
  rows: SIGNATURE_ROWS,
} as const satisfies LegalBlock;

const TRANSFER_SIGNATURES = {
  kind: "table",
  columns: [
    "Contractor — confirms the actions performed",
    "Customer — confirms receipt / acknowledgement",
  ],
  rows: SIGNATURE_ROWS,
} as const satisfies LegalBlock;

function partyName(party: PartyRequisites | undefined, placeholder: string): string {
  return agreementField(party?.name, placeholder);
}

function kppCell(party: PartyRequisites | undefined, placeholder: string): string {
  if (!party) return `KPP: ${placeholder}`;
  if (isSoleProprietorOrIndividual(party.kind)) return "KPP: not applicable";
  return `KPP: ${agreementField(party.kpp, placeholder)}`;
}

function registryCell(party: PartyRequisites | undefined, placeholder: string): string {
  if (party && isSoleProprietorOrIndividual(party.kind)) {
    return `PSRNSP: ${agreementField(party.ogrn, "[PSRNSP]")}`;
  }
  return `PSRN/PSRNSP: ${agreementField(party?.ogrn, placeholder)}`;
}

/** "represented by <position> <name>, acting under <document>". */
function representative(signatory: AgreementSignatory | undefined): string {
  const holder = [signatory?.position, signatory?.fullName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  const basis = agreementField(signatory?.authorityBasis, "[document]");
  return `${agreementField(holder, "[position and full name]")}, acting under ${basis}`;
}

/** "<name>, TIN <number>" — how a party is introduced in an appendix. */
function partyLine(party: PartyRequisites | undefined, namePlaceholder: string): string {
  return `${partyName(party, namePlaceholder)}, TIN ${agreementField(party?.inn, "[TIN]")}`;
}

function preamble(
  contractor: PartyRequisites | undefined,
  customer: PartyRequisites,
  signatory: AgreementSignatory | undefined,
): string {
  return (
    `Sole Proprietor Vladislav Sergeevich Bogatyrev, ` +
    `TIN ${agreementField(contractor?.inn, "[Contractor's TIN]")}, ` +
    `PSRNSP ${agreementField(contractor?.ogrn, "[Contractor's PSRNSP]")}, ` +
    `referred to as the "Contractor" and, in licensing relations, as the "Licensor", of the one part, and ` +
    `${partyName(customer, "[full name of the legal entity / sole proprietor]")}, ` +
    `TIN ${agreementField(customer.inn, "[Customer's TIN]")}, ` +
    `${registryCell(customer, "[number]")}, ` +
    `represented by ${representative(signatory)}, ` +
    `referred to as the "Customer" and, in licensing relations, as the "Licensee", of the other part, ` +
    `jointly referred to as the "Parties", have entered into this agreement (the "Agreement").`
  );
}

function requisitesRows(
  contractor: PartyRequisites | undefined,
  customer: PartyRequisites,
  signatory: AgreementSignatory | undefined,
): readonly (readonly string[])[] {
  return [
    [
      partyName(contractor, CONTRACTOR_DEFAULT_NAME),
      partyName(customer, "[full name / sole proprietor's full name]"),
    ],
    [
      `TIN: ${agreementField(contractor?.inn, "[TIN]")}`,
      `TIN: ${agreementField(customer.inn, "[TIN]")}`,
    ],
    [`PSRNSP: ${agreementField(contractor?.ogrn, "[PSRNSP]")}`, registryCell(customer, "[number]")],
    [
      "KPP: not applicable",
      kppCell(customer, "[for an organisation; not applicable to a sole proprietor]"),
    ],
    [
      `Address for correspondence: ${agreementField(contractor?.address, "[address]")}`,
      `Registered/postal address: ${agreementField(customer.address, "[address]")}`,
    ],
    [
      `E-mail: ${agreementField(contractor?.email, "hello@v-b.tech")}`,
      `E-mail: ${agreementField(customer.email, "[address]")}`,
    ],
    [
      `Telephone: ${agreementField(contractor?.phone, "+7 934 355-14-90")}`,
      `Telephone: ${agreementField(customer.phone, "[number]")}`,
    ],
    [
      `Bank: ${agreementField(contractor?.bankName, "[bank]")}`,
      `Bank: ${agreementField(customer.bankName, "[bank]")}`,
    ],
    [
      `BIC: ${agreementField(contractor?.bic, "[BIC]")}`,
      `BIC: ${agreementField(customer.bic, "[BIC]")}`,
    ],
    [
      `Settlement account: ${agreementField(contractor?.settlementAccount, "[account]")}`,
      `Settlement account: ${agreementField(customer.settlementAccount, "[account]")}`,
    ],
    [
      `Correspondent account: ${agreementField(contractor?.correspondentAccount, "[account]")}`,
      `Correspondent account: ${agreementField(customer.correspondentAccount, "[account]")}`,
    ],
    [
      `Tax regime as at the date of signature: ${agreementField(contractor?.taxRegime, "tax on professional income")}`,
      `Signatory: ${agreementField(
        [signatory?.position, signatory?.fullName].filter(Boolean).join(", "),
        "[position, full name]",
      )}`,
    ],
    ["", `Basis of authority: ${agreementField(signatory?.authorityBasis, "[document]")}`],
  ];
}

function bodySections(fields: TenantAgreementFields): readonly AgreementSection[] {
  const { customer } = fields;
  const contractor = fields.contractor;
  const signatory = fields.signatory;
  const terms = fields.terms;
  const number = agreementField(fields.number, "[number]");
  const city = agreementField(fields.city, "[city]");
  const conclusionDate = agreementDate(fields.conclusionDate, "[date of conclusion]");
  const penaltyRate = agreementField(terms?.penaltyRatePercent, "0.05");
  const penaltyCap = agreementField(terms?.penaltyCapPercent, "10");
  const disputeVenue = agreementField(
    terms?.disputeVenue,
    "[the Commercial Court of Krasnodar Territory / another agreed competent court]",
  );

  return [
    {
      id: "storony",
      heading: `Agreement No. ${number}`,
      blocks: [
        {
          kind: "callout",
          tone: "warning",
          text: "DRAFT. This text does not confirm that an agreement has been concluded and does not replace a lawyer's review of the specific model of performance. Before it is sent to a customer, the parties' requisites, the signatories' authority, the order with its price and exact dates, the composition of access, the supported equipment and scenarios, and the particulars of data processing and engaged persons must be completed.",
        },
        {
          kind: "table",
          columns: ["Agreement detail", "Value"],
          columnRatios: [1, 2.4],
          rows: [
            ["Agreement number", number],
            ["Place of conclusion", city],
            ["Date of conclusion", conclusionDate],
          ],
        },
        {
          kind: "paragraph",
          text: preamble(contractor, customer, signatory),
        },
      ],
    },
    {
      id: "predmet",
      heading: "1. Subject matter and structure of the agreement",
      blocks: [
        {
          kind: "paragraph",
          text: "1.1. The Contractor grants the Customer a simple (non-exclusive) licence to its own computer program Markiro, provides access to its server-side functionality and, under separately agreed assignments, renders services and performs works. The Customer accepts due performance and pays for it on the terms of the Agreement and of the orders.",
        },
        {
          kind: "paragraph",
          text: "1.2. The program is intended for the agreed operations of code verification, production recording, aggregation, printing, stocktaking and information exchange. The composition of the components, modules and methods of use provided is determined by an order in the form of Appendix No. 1. The presence of a feature in development plans does not mean it is included in the licence.",
        },
        {
          kind: "paragraph",
          text: "1.3. The Agreement is a framework agreement of a mixed nature. Specific obligations arise from signed orders and assignments. The price of the licence and the composition of access must be determined before the licence is granted; additional services and works are not deemed ordered merely because the Agreement has been signed.",
        },
        {
          kind: "paragraph",
          text: "1.4. The \"Customer's cabinet\" (tenant) means the separate area of data and settings of a single Customer within the Markiro service. A tenant is not an independent party to the Agreement. Affiliated companies and other TINs do not automatically obtain access to the Customer's data and rights.",
        },
        {
          kind: "paragraph",
          text: "1.5. In the event of a conflict, the documents apply in the following order of priority, from highest to lowest: expressly agreed special terms of a signed order or assignment; Appendix No. 3 as regards the processing of personal data; Appendix No. 9 as regards the signatories' authority, the methods of signature and the delivery of messages; Appendix No. 2 as regards support, the end of access and the handling of data; this Agreement; the other appendices. The instructions published on the website govern the use of the software within the agreed scope, but their unilateral update does not change the price, the term or the essential composition of an order that has already been paid for.",
        },
      ],
    },
    {
      id: "obekt-litsenzii",
      heading: "2. Object of the licence and limits of use",
      blocks: [
        {
          kind: "paragraph",
          text: "2.1. The object of the licence is the Markiro computer program, including only those web components, station client, handheld terminal application, kiosk, connection agent and other components listed in the order, the rights to which belong to the Contractor. The product website is markiro.app. The versions and updates issued are identified in the issue log or in the activation notice; a certificate of registration of the program is not a condition for granting the licence.",
        },
        {
          kind: "paragraph",
          text: "2.2. The following are permitted: recording and storing the object code of the agreed client components in the memory of the Customer's devices; launching and using those components for their intended purpose; reproducing the web client in the browser's memory and working through the service interface; making the necessary back-up copies of the client components; using the standard exchange interfaces within the agreed scope. The Customer's own data is processed and exported by the means permitted by the program.",
        },
        {
          kind: "paragraph",
          text: "2.3. The territory of the licence is the Russian Federation unless the order expressly agrees otherwise. The term is the exact dates and times stated in the order, but no longer than the duration of the corresponding exclusive right. The right is not alienated; sub-licensing and providing the service to third parties in one's own name are not permitted.",
        },
        {
          kind: "paragraph",
          text: "2.4. The program may be used by authorised employees and by users engaged by the Customer solely for the Customer's activity and within the roles assigned to them. The Customer is responsible for the lawfulness of the access it grants. The cabinet owner's account does not automatically confer the right to sign contractual documents on the Customer's behalf.",
        },
        {
          kind: "paragraph",
          text: "2.5. A working device is one registered installation of the station or of the handheld terminal application that is permitted to operate; both types draw on a common quota. The number of operators does not increase the number of devices. Kiosks have a separate quota. Disconnecting from the internet does not free a slot. A device is replaced by withdrawing the previous installation from service and preserving its data queue, without granting one slot twice.",
        },
        {
          kind: "paragraph",
          text: "2.6. Transferring keys to outsiders, circumventing access restrictions, unauthorised interference with the operation of the service and use beyond the licence are prohibited. These restrictions do not override the actions of a lawful user permitted by mandatory rules of law. Access to the source code and an on-premises server installation at the Customer are not part of a standard order.",
        },
        {
          kind: "paragraph",
          text: "2.7. The licence concerns Markiro functionality and not rights to Chestny ZNAK, the National Catalogue, 1C, cryptographic tools or other third-party products. Rights to third-party components are governed by their own terms; the Contractor grants no rights beyond those it holds. The results of the work and imported data are used in compliance with the rights of their lawful holders.",
        },
      ],
    },
    {
      id: "zakaz",
      heading: "3. Order, activation and change of plan",
      blocks: [
        {
          kind: "paragraph",
          text: '3.1. An order in the form of Appendix No. 1 determines the cabinet, the TIN, the site, the plan and the revision of its composition, the quotas, the modules, the supported scenarios, the period and the fee. For each quota, "0", a specific number or "unlimited" is stated expressly; a blank field does not mean unlimited.',
        },
        {
          kind: "paragraph",
          text: "3.2. Once the order has been agreed, the Customer has completed the mandatory preparatory steps and the payment condition has been met, the Contractor activates access within two working days unless the order states a different period. A notice is delivered stating the cabinet identifier, the composition of access and the actual date of activation; secrets are not included in statements or invoices.",
        },
        {
          kind: "paragraph",
          text: "3.3. The licence period does not begin earlier than access is actually granted. Where the delay is the Contractor's fault, the end dates shift so that the paid duration is preserved, unless the Customer has chosen another agreed form of settlement. Where the Customer delays its preparation, a new date is agreed; services not rendered are not deemed performed.",
        },
        {
          kind: "paragraph",
          text: "3.4. Renewal, the purchase of an add-on and a change of quotas are made by a new order or by amending the existing one. The price and the manner of crediting the remainder of the period are fixed before payment. Automatic debiting of funds and automatic acceptance of a new price list are not provided for.",
        },
        {
          kind: "paragraph",
          text: "3.5. Downgrading a plan does not change past periods and does not delete data. If the new quota is exceeded, the Customer chooses which working devices to retain; until it does, new operations on the surplus devices are restricted, but the data recovery procedure under Appendix No. 2 is preserved. Free pilots are documented by a separate order with a specific term and an express statement that they are free of charge.",
        },
      ],
    },
    {
      id: "tsena",
      heading: "4. Price, settlements and tax status",
      blocks: [
        {
          kind: "paragraph",
          text: "4.1. All prices are expressed in roubles. The licence fee, the cost of services and the cost of works are stated separately. Maintaining the server component for normal use is included in the agreed licence price; reselling hosting, equipment or third-party licences separately is not the subject matter of the Agreement.",
        },
        {
          kind: "paragraph",
          text: "4.2. By default the licence is granted on terms of 100 per cent prepayment; an invoice is paid within five working days of its receipt. Services and works are paid for under the assignment. A payment relates to the invoice it names; where the designation is insufficient, the Parties clarify the allocation. The payment obligation is performed when the funds are credited to the Contractor's account.",
        },
        {
          kind: "paragraph",
          text: "4.3. As at the date of the Agreement the Contractor declares that it applies the tax on professional income. While that regime is lawfully applied to the relevant income, the cost is stated without VAT under part 9 of article 2 of Federal Law No. 422-FZ. The Customer may verify the status by TIN; the Contractor provides current confirmation on request.",
        },
        {
          kind: "paragraph",
          text: "4.4. On receiving payment, including prepayment, the Contractor generates and delivers to the Customer a professional-income-tax receipt stating the Customer's TIN and the actual amount settled, within the periods set by article 14 of Federal Law No. 422-FZ. For an ordinary bank transfer the Parties set a contractual period — no later than the next working day, but in any event no later than the period established by law. For cash and electronic means of payment the statutory period applies. An invoice and a statement do not replace the receipt.",
        },
        {
          kind: "paragraph",
          text: "4.5. The Contractor gives notice of the loss or termination of the professional-income-tax regime no later than two working days after it becomes aware of it and, where possible, before the next settlement. The Parties bring the documents for subsequent transactions into line with the applicable regime. A change of tax status does not of itself increase the agreed final price of an order already paid for or signed; recalculating future orders requires agreement, except where the law mandates otherwise.",
        },
        {
          kind: "paragraph",
          text: "4.6. A refund is accompanied by a proper amendment of the settlement particulars in the established manner; the Contractor informs the Customer of the cancellation or replacement of an erroneous receipt and delivers the correct particulars. A receipt may not be cancelled while the income actually received remains valid and there is no lawful ground for cancellation.",
        },
        {
          kind: "paragraph",
          text: "4.7. The Contractor organises its activity independently; no employment relationship with the Customer arises under the Agreement. The Parties do not document services or works under the professional-income-tax regime where the exception for a current or former employer established by clause 8 of part 2 of article 6 of Federal Law No. 422-FZ applies. Naming that regime in the Agreement does not change the tax characterisation of the activity actually carried out.",
        },
        {
          kind: "paragraph",
          text: "4.8. The Parties take into account that the professional-income-tax regime is limited by the maximum annual income established by clause 8 of part 2 of article 4 of Federal Law No. 422-FZ. The Contractor monitors that limit itself and, in good time before issuing an invoice that may cause it to be exceeded, informs the Customer in writing of the intended change to a different tax regime and of the applicable taxation procedure. The price of an order already signed remains unchanged and is treated as including the relevant tax unless the parties have expressly agreed otherwise in a separate document. For subsequent orders the price and the tax statement are agreed afresh before payment.",
        },
      ],
    },
    {
      id: "uslugi",
      heading: "5. Services, works and bespoke development",
      blocks: [
        {
          kind: "paragraph",
          text: "5.1. Additional performance begins once an assignment in the form of Appendix No. 4 has been agreed. It defines the result or the list of actions, the input data, the scope, the equipment, the term, the price, the acceptance criteria and the exclusions. Exceeding the hours or extending the result requires prior written agreement; silence does not amount to an order for additional chargeable work.",
        },
        {
          kind: "paragraph",
          text: "5.2. The Customer provides lawful access, prepared data and an authorised contact representative in good time. The Contractor reports obstacles and their effect on the deadlines. Where the necessary cooperation is absent, the deadline is extended by the confirmed period of delay after notice, without automatic payment for actions not performed.",
        },
        {
          kind: "paragraph",
          text: "5.3. The Customer acquires equipment, third-party licences, qualified electronic signatures, marking codes and external system services directly. Under the Agreement the Contractor does not act as the Customer's agent, commission agent or representative for procurement, registration or the signing of documents. Technical configuration is carried out within the rights granted; the private keys of the qualified electronic signature remain under the Customer's control.",
        },
        {
          kind: "paragraph",
          text: "5.4. Rights to Markiro as previously created, to shared components and to tools remain with the Contractor and other lawful right holders. The terms concerning a new protected result are agreed expressly in the assignment: its name, the right holder, the methods and term of use, the territory and the fee for the rights. Assignment of the exclusive right, delivery of the source code or a perpetual licence do not arise merely from payment for configuration or development.",
        },
        {
          kind: "paragraph",
          text: "5.5. Where the assignment provides for a work to be created personally by the Contractor as its author, the corresponding part of the relationship is documented with regard to articles 1288-1290 of the Civil Code of the Russian Federation. Before the work begins, the work itself, the period for its delivery and the applicable terms as to rights are determined. Mandatory rules, including those on the grace period, remain in force. If the essential terms are not completed, authored development does not begin.",
        },
        {
          kind: "paragraph",
          text: "5.6. Retainer support arises only under a separate order. The fee is paid for the availability of the agreed assistance during the period, including the limit provided for; the number of requests actually made is reflected in the report. Unused minutes do not carry over unless the order provides otherwise. The absence of requests does not permit fictitious hours to be entered in a statement. An hourly model is paid on the volume actually confirmed.",
        },
      ],
    },
    {
      id: "priemka",
      heading: "6. Delivery and acceptance of performance",
      blocks: [
        {
          kind: "paragraph",
          text: "6.1. The grant of the right of use is confirmed by the activation of the agreed access and by a statement in the form of Appendix No. 6. A document granting a right for a specified period does not confirm that future services have been rendered. A statement for services and works in the form of Appendix No. 7 is drawn up after a stage has actually been performed or a reporting period has ended.",
        },
        {
          kind: "paragraph",
          text: "6.2. Within five working days of receiving the result and the corresponding document the Customer signs it or sends reasoned objections referring to the agreed scope. The Contractor remedies confirmed non-conformities within the agreed period and delivers the result again; new wishes that have not been agreed do not count as a defect.",
        },
        {
          kind: "paragraph",
          text: "6.3. Where no objections are made within that period and there is evidence that access or the result was actually provided and that the document was delivered, performance is deemed accepted for the purposes of the Agreement. The Contractor may draw up a unilateral document enclosing that evidence. This does not mean that the system affixes the Customer's signature and does not deprive the Customer of the right to assert latent defects or performance that did not in fact take place.",
        },
        {
          kind: "paragraph",
          text: "6.4. Primary documents state the actual dates, content, scope and cost, the particulars of the Parties and the responsible signatories. A single document with separate sections on rights, services and works is permitted provided the dates and content are stated accurately. Signing a statement without any new receipt of funds does not require a prepayment already recorded to be recorded again.",
        },
      ],
    },
    {
      id: "ekspluatatsiya",
      heading: "7. Operation, integrations and the parties' obligations",
      blocks: [
        {
          kind: "paragraph",
          text: "7.1. The Contractor maintains the agreed functionality, preserves the separation of access between cabinets, handles requests and corrects confirmed defects in its own software within the framework of the Agreement. Correcting such a defect is not charged for as bespoke development. The procedure for support, updates and wind-down is set out in Appendix No. 2.",
        },
        {
          kind: "paragraph",
          text: "7.2. The Customer is responsible for the lawfulness and accuracy of the data it enters, for the parameters of its products, for its equipment and network, for its users' authority and for the timely performance of the mandatory actions in state and accounting systems. These obligations do not release the Contractor from liability for its own breaches.",
        },
        {
          kind: "paragraph",
          text: "7.3. Import from the National Catalogue is carried out through the connection to Chestny ZNAK. New external requests require the integration to be enabled, the sub-feature to be provided for in the order and the Customer's authority to be valid. Disabling the integration does not delete cards already saved. Access to the public API and to the standard exchange with 1C is governed separately; it does not replace the right of access to Chestny ZNAK.",
        },
        {
          kind: "paragraph",
          text: "7.4. The program is not an operator of Chestny ZNAK, a certification authority, a cash register or an accounting outsourcing service. The transmission of particulars by the program does not mean that they have been accepted by the external system; the Customer checks the receipts and statuses. The dispensing kiosk records the operations provided for and does not replace the withdrawal from circulation required by the process. The Contractor does not warrant universal compatibility with all product groups, device models and 1C configurations.",
        },
        {
          kind: "paragraph",
          text: "7.5. A change in the rules or interfaces of an external system may require adaptation. The Contractor gives notice of the effect and proposes an available workaround or a plan of adaptation. New chargeable development is agreed separately. A technical failure of an external service does not of itself terminate the Contractor's obligations to safeguard data already received and to inform the Customer.",
        },
      ],
    },
    {
      id: "dannye",
      heading: "8. Data and confidentiality",
      blocks: [
        {
          kind: "paragraph",
          text: "8.1. The Customer retains the rights to and lawful control over the data it provides; third parties' rights do not pass to the Contractor. The Contractor may use the data only to perform the Agreement and for the separately defined lawful purposes of its own set out in Appendix No. 3. Advertising, publishing a case study naming the Customer and training external models on the Customer's data require separate permission.",
        },
        {
          kind: "paragraph",
          text: "8.2. The instruction to process personal data is documented by Appendix No. 3 before production personal data is uploaded. The Customer is the operator of the data entrusted; the Contractor is the person processing it on the Customer's instruction. For its own settlements and mandatory records the Contractor acts in its own capacity on a separate lawful basis.",
        },
        {
          kind: "paragraph",
          text: "8.3. The Parties keep non-public data, keys, and commercial and technical particulars confidential, restrict access to the persons who need it and apply protective measures. The obligation applies during the Agreement and for three years after its termination and, for personal data, access secrets and information protected by law, for the mandatory periods and on the mandatory grounds. Exceptions: publicly available information, information lawfully obtained independently, and information disclosed under a mandatory requirement of law.",
        },
        {
          kind: "paragraph",
          text: "8.4. Export, blocking, return and deletion are governed by Appendices No. 2 and No. 3. The existence of a debt is not a ground for destroying data or withholding the standard export provided for. Indefinite archival storage of all of the Customer's regulatory documents is not included in the licence.",
        },
      ],
    },
    {
      id: "otvetstvennost",
      heading: "9. Liability and force majeure",
      blocks: [
        {
          kind: "paragraph",
          text: "9.1. The Parties are liable for a proven breach, having regard to fault, causation and the applicable rules of law. A party may not be released in advance from liability for an intentional breach. The Contractor gives no unconditional warranty that the software is free of all errors or that the Customer will achieve any particular economic result.",
        },
        {
          kind: "paragraph",
          text: "9.2. Where paid-for rights are not granted or a material non-conformity is not remedied, the Customer may require that it be remedied, that the price be reduced proportionately, or that the corresponding order be terminated with the unearned part refunded. Rights to compensation for losses provided for by law are preserved within the limits of this section.",
        },
        {
          kind: "paragraph",
          text: "9.3. Where the law permits a limitation, each Party's aggregate liability for ordinary contractual breaches is limited to the price of the order affected; lost profit is not compensated. The limitation does not apply to the obligation to pay for performance or to refund an unearned prepayment, to an intentional breach, to a breach of confidentiality or data protection, to the absence of the declared rights to the software, or to cases where a limitation is prohibited by law. Public-law liability does not transfer automatically to the other Party.",
        },
        {
          kind: "paragraph",
          text: "9.4. Extraordinary circumstances that could not be prevented in the given conditions are taken into account in accordance with the law. A Party gives notice to the other without undue delay, confirms the effect and takes steps to mitigate the consequences. Ordinary failures of a subcontractor, a lack of funds or a lack of internet access are not automatically recognised as force majeure. Where the impediment lasts more than 30 calendar days, the Parties agree the termination of the order affected and settlement for performance actually rendered.",
        },
        {
          kind: "paragraph",
          text: `9.5. For late payment the Customer, at the Contractor's written demand, pays a penalty of ${penaltyRate} per cent of the overdue amount for each calendar day of delay, but no more than ${penaltyCap} per cent of that amount. For a delay caused by the Contractor in activating the agreed access or delivering the result, the Customer may demand a penalty at the same rate on the price of the affected item of the order or assignment. The penalty accrues only from the date the written demand is received and does not accrue for any period during which performance was impossible through the fault of the other Party. Payment of the penalty does not release a Party from performing the obligation; interest under article 395 of the Civil Code of the Russian Federation is not charged in addition for the same period.`,
        },
        {
          kind: "paragraph",
          text: "9.6. If a third party brings a claim against the Customer for infringement of an exclusive right arising from the use of Markiro within the limits of the Agreement, the Customer informs the Contractor in writing within five working days, does not admit the claim without agreement, and gives the Contractor the opportunity to conduct the defence and negotiations at the Contractor's expense. The Contractor compensates the Customer's confirmed losses and the sums awarded under such a claim without applying the limitation in clause 9.3. The Contractor may, at its option, secure the right to continued use, replace or modify the disputed component, or terminate the order affected and refund the unearned part of the price. This clause does not apply where the claim is caused by the Customer's data, by third-party systems, by unauthorised modification of the software or by use beyond the licence.",
        },
      ],
    },
    {
      id: "srok",
      heading: "10. Term, restriction of access and termination",
      blocks: [
        {
          kind: "paragraph",
          text: "10.1. The Agreement is in force from signature until it is terminated by agreement or on a ground provided for; the term of each licence is determined separately. The end of one order does not terminate the obligations as to settlements, accepted works, data and confidentiality. Non-payment for a new period does not of itself create a debt for a licence that has not been renewed.",
        },
        {
          kind: "paragraph",
          text: "10.2. After the paid period ends, new operations are restricted. Assignments already begun are completed in the restricted manner set out in Appendix No. 2; recorded facts are not deleted because of the delay. Where security is threatened, compromised access may be disabled immediately, with notice and a separate secure means of recovering the data.",
        },
        {
          kind: "paragraph",
          text: "10.3. The Customer may decline to renew and may terminate a licence order early on 10 calendar days' notice. Unless the order expressly agrees otherwise within the limits permitted by law, the refund is calculated in proportion to the days unused after the date of termination, on the price actually paid for the period, without recalculating the days elapsed at a higher rate.",
        },
        {
          kind: "paragraph",
          text: "10.4. Termination of services at the Customer's initiative is effected with payment for what has been rendered and for the expenses actually incurred that are provided for by law, without double counting; a prepayment is refunded net of those sums. For contract works, article 717 of the Civil Code of the Russian Federation and the agreed actual performance are taken into account; for an author's commission, the special rules apply. The Agreement does not restrict the mandatory rights of withdrawal. The Contractor may withdraw from services only in compliance with the applicable conditions, including article 782 of the Civil Code of the Russian Federation.",
        },
        {
          kind: "paragraph",
          text: "10.5. In the event of a material breach the Contractor first sends a description of the breach and a demand that it be remedied. Termination of a licence order on the ground of non-payment is effected in compliance with the applicable conditions of article 1237 of the Civil Code of the Russian Federation. Where a licence is simply not renewed, the expiry of the term is sufficient; automatic destruction of data or immediate termination on that ground is not permitted.",
        },
        {
          kind: "paragraph",
          text: "10.6. Unearned amounts are refunded within 10 working days after the amount to be refunded has been determined and the necessary bank details have been received; the undisputed part is not withheld pending the resolution of a dispute over the remainder. The Parties reconcile the refund with the original invoice, payment and receipt. The procedure for handing over data continues to apply regardless of a monetary dispute.",
        },
      ],
    },
    {
      id: "dokumenty",
      heading: "11. Documents, notices and disputes",
      blocks: [
        {
          kind: "paragraph",
          text: "11.1. The Agreement and its appendices are signed on paper or with an enhanced qualified electronic signature. Any other method is permitted only under the expressly agreed rules of Appendix No. 9, which make it possible to identify the signatory, the signatory's authority and the unaltered content of the document. An ordinary login to the cabinet, the scanning of goods or the pressing of an operational button does not constitute signature of the agreement.",
        },
        {
          kind: "paragraph",
          text: "11.2. Notices are sent to the agreed addresses and channels. Receipt is confirmed by the electronic document management system, by the addressee's reply, by a delivery log in the agreed system or by another reliable body of evidence. A single record of dispatch is not sufficient for an unqualified conclusion that delivery occurred. A change of bank details or of signatories is confirmed through a secure or previously agreed channel.",
        },
        {
          kind: "paragraph",
          text: `11.3. The law of the Russian Federation applies. A claim is sent with a description of the breach and supporting materials; a reply follows within 15 working days unless the law sets another mandatory period. Failing agreement, the dispute is referred to ${disputeVenue} unless mandatory rules of jurisdiction require otherwise. The impossibility of applying a particular provision does not annul the remaining permissible provisions.`,
        },
        {
          kind: "paragraph",
          text: "11.4. Signed Appendices No. 1-3 and No. 9 and agreed assignments in the form of No. 4 are integral parts, while forms No. 5-8 and No. 10 are used when the corresponding events occur. Completed forms receive their own number and date. Appendix No. 4 is drawn up only for services or works that have been ordered; the absence of such an assignment does not prevent a standalone licence.",
        },
        {
          kind: "paragraph",
          text: "11.5. Assignment of rights and transfer of debt under the Agreement are permitted only with the prior written consent of the other Party. The Contractor does not need consent to assign a monetary claim for payment for performance already accepted, or for the transfer of rights and obligations upon reorganisation or upon transferring the activity to a legal entity established by the Contractor, of which the Customer is notified at least 10 working days in advance with the new details given through a secure or previously agreed channel. An assignment does not change the price, term or composition of an order already paid for, nor does it transfer to the acquirer rights to the computer program beyond the scope of the Agreement.",
        },
        {
          kind: "paragraph",
          text: "11.6. The Agreement may be executed in a bilingual form in which the Russian and English texts appear in parallel. The English text is provided for the Parties' convenience; in the event of any discrepancy between the Russian and English texts, the Russian text shall prevail.",
        },
        {
          kind: "paragraph",
          text: "11.7. The document forms set out in Appendices No. 5-8 are forms of primary accounting documents and are provided in Russian regardless of the form in which the Agreement is executed.",
        },
      ],
    },
    {
      id: "rekvizity",
      heading: "12. Requisites and signatures",
      startsPage: true,
      blocks: [
        {
          kind: "table",
          columns: ["Contractor / Licensor", "Customer / Licensee"],
          rows: requisitesRows(contractor, customer, signatory),
        },
        SIGNATURES,
      ],
    },
  ];
}

function appendixOneTwoSections(fields: TenantAgreementFields): readonly AgreementSection[] {
  const number = agreementField(fields.number, "[number]");
  const conclusionDate = agreementDate(fields.conclusionDate, "[date of conclusion]");
  const { customer } = fields;
  const contractor = fields.contractor;

  return [
    {
      id: "prilozhenie-1",
      heading: "Appendix No. 1. Order for the grant of rights and access",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `To agreement No. ${number} of ${conclusionDate}. Order No. [order number] of [date], revision [number]. Contractor: ${partyLine(contractor, CONTRACTOR_DEFAULT_NAME)}. Customer: ${partyLine(customer, "[full name / sole proprietor's full name]")}.`,
        },
        {
          kind: "table",
          columns: ["Identification", "Agreed value"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "Cabinet / tenant ID",
              "[identifier; on first connection it is stated in the activation notice]",
            ],
            [
              "Organisation and site",
              "[one TIN; address of the production site; other sites only if expressly listed]",
            ],
            [
              "Plan and revision of its composition",
              "[Start / Workshop / Production / bespoke]; [code and version]",
            ],
            [
              "Period of use",
              "From [date, time] inclusive to [date, time] exclusive; time zone Moscow (UTC+3). For a date expressed as “until ... inclusive”, the end is 00:00 of the following day.",
            ],
            [
              "Activation",
              "[exact date / after the conditions are met]; payment condition: [condition]. The dates are confirmed by notice.",
            ],
            ["Territory", "Russian Federation; other: [not applicable / list]"],
            [
              "Cabinet owner",
              "[full name, personal e-mail]; signing authority only under Appendix No. 9.",
            ],
          ],
        },
      ],
    },
    {
      id: "prilozhenie-1-kvoty",
      heading: "Appendix No. 1 · 1. Composition of the licence and quotas",
      blocks: [
        {
          kind: "table",
          columns: ["Resource / capability", "Included / quantity", "Scenario limitation"],
          columnRatios: [1.5, 1, 2],
          rows: [
            [
              "Working devices: stations + handheld terminals",
              "[number / unlimited]",
              "One common quota; replacement without using one slot twice at the same time.",
            ],
            [
              "Dispensing kiosks",
              "[0 / number / unlimited]",
              "A separate quota; it is not a cash register.",
            ],
            ["Cabinet lines", "[number / unlimited]", "A blank field does not mean unlimited."],
            [
              "Cabinet users",
              "[number / unlimited]",
              "The number of operators is not charged by the number of devices.",
            ],
            ["Code verification, boxes, printing", "[yes / no]", "[agreed operations]"],
            ["Label editor", "[yes / no]", "[limitations, or none]"],
            ["Stocktaking and repacking", "[yes / no]", "[verified modes and formats]"],
            ["Chestny ZNAK integration", "[yes / no]", "[list of supported operations]"],
            [
              "Qualified electronic signature agent for Chestny ZNAK",
              "[yes / no]",
              "[the Customer's Windows machine, token and certificate; the private key stays with the Customer]",
            ],
            [
              "Import from the National Catalogue",
              "[yes / no]",
              "Only through an enabled Chestny ZNAK integration and the Customer's own connection.",
            ],
            [
              "Standard exchange with 1C / CommerceML",
              "[yes / no]",
              "[configuration, version, direction and composition of the exchange]",
            ],
            [
              "Cabinet reports and exports",
              "[yes / no]",
              "[list of reports and machine-readable formats]",
            ],
            ["Public API", "[yes / no]", "[available operations and technical profile]"],
            [
              "Handheld terminal application",
              "[yes / no / pilot]",
              "[version, models, verified modes]",
            ],
            [
              "Pallets / other capabilities",
              "[none / list]",
              "Future features are not included by the name of a plan alone.",
            ],
          ],
          caption:
            "Blank or mutually exclusive fields are agreed before activation. A commercial quota of “unlimited” does not override the agreed technical measures protecting the service or the limitations of external systems.",
        },
      ],
    },
    {
      id: "prilozhenie-1-voznagrazhdenie",
      heading: "Appendix No. 1 · 2. Fee",
      blocks: [
        {
          kind: "table",
          columns: ["Item", "Period / unit", "Qty", "Price, RUB", "Amount, RUB"],
          columnRatios: [3.4, 1.1, 0.7, 1, 1],
          rows: [
            [
              "Right to use the Markiro computer program, plan “[name]”, [period]",
              "[month / year / period]",
              "[number]",
              "[amount]",
              "[amount]",
            ],
            [
              "Additional right: [name of functionality / resource], [period]",
              "[unit]",
              "[number]",
              "[amount]",
              "[amount]",
            ],
            ["TOTAL", "—", "—", "—", "[amount]"],
          ],
          caption:
            "Without VAT: the Contractor applies the tax on professional income; the ground is part 9 of article 2 of Federal Law No. 422-FZ of 27 November 2018.",
        },
        {
          kind: "paragraph",
          text: "Payment terms: [100% prepayment / another arrangement]. Invoice No. [number] of [date]. Payment due: [date / five working days]. The cost of services and works is not included in the licence amount, except for the obligations expressly stated below. For a pilot, instead of a price the following must be stated expressly: “The licence is granted free of charge”; an agreed term is mandatory in that case.",
        },
      ],
    },
    {
      id: "prilozhenie-1-podgotovka",
      heading: "Appendix No. 1 · 3. Preparation and verified conditions",
      blocks: [
        {
          kind: "table",
          columns: ["Parameter", "Agreed value"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "Equipment and operating system",
              "[models of stations/handheld terminals, scanners, printers; versions of the operating system and client software]",
            ],
            [
              "Products and external operations",
              "[product groups, Chestny ZNAK operations, 1C versions, test scenarios]",
            ],
            [
              "Documents and data export",
              "[list of available documents and machine-readable formats, for example CSV/JSON; methods of receipt]",
            ],
            [
              "Technical limitations",
              "[profile and version: file size, parallel tasks, request rate; or a separately agreed description]",
            ],
            [
              "Retention period for working data",
              "[period / until the purpose is achieved]; the Customer keeps the sources of any mandatory archive itself.",
            ],
            [
              "Backup and recovery",
              "[frequency; retention of copies; method and period of recovery testing; RPO/RTO where agreed]",
            ],
            ["Additional services", "[not ordered / assignment number from Appendix No. 4]"],
            [
              "Retainer support",
              "[not ordered / package, price, period, included minutes, schedule; a separate assignment]",
            ],
          ],
        },
      ],
    },
    {
      id: "prilozhenie-1-izmeneniya",
      heading: "Appendix No. 1 · 4. Amendments and special terms",
      blocks: [
        {
          kind: "paragraph",
          text: "Order being amended: [none / number]. Date of amendment: [date]. Credit for the unused part: [formula and amount / not applicable]. Future device quota and the devices selected for retention: [particulars]. Other agreed departures from the Agreement: [none / list stating the clauses amended].",
        },
        {
          kind: "paragraph",
          text: "Versions of the instructions and agreed materials: [identifiers / list of attached files]. Pilot features and acceptance limitations: [none / list]. Updates to the website do not replace the signed composition of this order.",
        },
        SIGNATURES,
      ],
    },
    {
      id: "prilozhenie-2",
      heading: "Appendix No. 2. Support and wind-down regulations",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `To agreement No. ${number} of ${conclusionDate}. These regulations apply to all of the Customer's orders unless an individual order provides otherwise.`,
        },
      ],
    },
    {
      id: "prilozhenie-2-podderzhka",
      heading: "Appendix No. 2 · 1. Support and updates",
      blocks: [
        {
          kind: "paragraph",
          text: "2-A.1. Basic support covers receiving error reports, diagnosing a confirmed Markiro defect and informing the Customer of the resolution. Bespoke process configuration, data preparation, additional training and the development of functionality are paid for only under a separate assignment. An initial report of a suspected error is not an order for a chargeable service.",
        },
        {
          kind: "table",
          columns: ["Condition", "Basic rule"],
          columnRatios: [1, 2.4],
          rows: [
            ["Channel", "hello@v-b.tech; other agreed channel: [address / not applicable]."],
            [
              "Hours for handling requests",
              "Monday to Friday, 10:00-18:00 Moscow time, excluding Russian public holidays.",
            ],
            [
              "First substantive reply",
              "Within one support working day of receiving the request. This is not a promise to fix the issue within one day.",
            ],
            [
              "Content of a request",
              "Cabinet, version, time, description of the operation and the error, request identifier; without passwords, private keys or excessive personal data.",
            ],
            [
              "Priority",
              "A stoppage of an agreed process and a risk of data loss are dealt with ahead of questions of convenience and new features.",
            ],
            [
              "Time to resolve",
              "Following diagnosis, a workaround and an estimate are communicated; a binding separate SLA applies only if one has been signed.",
            ],
            [
              "Updates",
              "The versions and fixes included in the order. Material process changes are notified in advance; an unscheduled update is permitted to remove a security threat.",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "2-A.2. Round-the-clock cover, a guaranteed availability percentage, on-site attendance and a specific restoration time are not promised by default. Particular metrics apply only under a completed and signed order. This does not release the Contractor from the obligation to perform within the agreed scope.",
        },
        {
          kind: "paragraph",
          text: "2-A.3. Planned works capable of interrupting agreed operations are, where possible, carried out outside the Customer's production window with at least one working day's notice. Where emergency protection is required, notice is given without undue delay. A change of version must not silently widen the data transmitted or enable a new chargeable module.",
        },
      ],
    },
    {
      id: "prilozhenie-2-sreda",
      heading: "Appendix No. 2 · 2. Responsibility for the working environment",
      blocks: [
        {
          kind: "paragraph",
          text: "2-A.4. The Customer provides serviceable devices, consumables, a network, lawful licences for the operating system, 1C and cryptographic tools, and access to external systems. The Contractor agrees the supported combinations of equipment and versions before launch. An unverified model or mode is documented as a pilot rather than as unconditionally supported.",
        },
        {
          kind: "paragraph",
          text: "2-A.5. Backup of server data and the recovery procedure are recorded in the order before the production launch. The safety of data not yet synchronised from a device also depends on local storage: the Customer does not reinstall the client or clear the database while a queue remains undelivered without agreed recovery. The Contractor does not require such a queue to be deleted in order to resolve a licensing problem.",
        },
      ],
    },
    {
      id: "prilozhenie-2-okonchanie",
      heading: "Appendix No. 2 · 3. End or reduction of access",
      blocks: [
        {
          kind: "table",
          columns: ["Action", "After the paid period ends"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "New shift, stocktake, new device",
              "Not permitted unless a renewal or new temporary access has been agreed.",
            ],
            [
              "A previously permitted assignment",
              "Up to 72 hours — a limited safe completion within the recorded assignment; without opening new assignments or extending an old shift without limit.",
            ],
            [
              "Accumulated event queue",
              "For 30 calendar days, the transmission and reconciliation of facts already recorded are permitted. Disputed events are retained for reconciliation rather than accepted unchecked.",
            ],
            [
              "An external request begun before the end",
              "The result of that same request may still be received where lawful authority exists. A new request is not created in the guise of a repeat.",
            ],
            [
              "History and standard export",
              "For up to 30 calendar days — reading and receiving data in the agreed format. If the interface is unavailable, the Contractor provides the agreed export by another secure means.",
            ],
            [
              "Previously imported cards",
              "Not deleted merely because Chestny ZNAK or the National Catalogue has been disconnected; further external updating requires valid access.",
            ],
            [
              "A compromised key",
              "Immediate restriction on security grounds; recovery on confirmed identification rather than through the unsafe key.",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "2-B.1. The 72-hour period is a contractual completion window, not a fresh full right to use the program. The list of permitted assignments and devices is fixed as at the moment the period ends. After the window closes, previously recorded data may be saved, transmitted and reconciled, but production may not continue in an indefinitely open shift.",
        },
        {
          kind: "paragraph",
          text: "2-B.2. A loss of connection does not of itself extend the licence. The application shows the time remaining and preserves the queue. If the technical implementation temporarily fails to provide a safe standard path, the Contractor arranges an agreed manual path for extracting or receiving the data without destroying it and without granting new commercial rights.",
        },
        {
          kind: "paragraph",
          text: "2-B.3. Before a quota is reduced the Parties determine which devices are retained and how the rest are wound down. Data already recorded is not deleted in order to bring the counter down to the quota. The Customer is not required to buy a licence again merely to obtain the standard export of its own data provided for here.",
        },
      ],
    },
    {
      id: "prilozhenie-2-vygruzka",
      heading: "Appendix No. 2 · 4. Export and deletion",
      blocks: [
        {
          kind: "paragraph",
          text: "2-B.4. Within 30 days after the end, the Customer receives the standard export in the formats listed in the order. It does not include the server source code, other cabinets' data or internal secrets. Where another lawful instruction exists, the agreed procedure of Appendix No. 3 applies; personal data is not retained contrary to a mandatory requirement to delete it.",
        },
        {
          kind: "paragraph",
          text: "2-B.5. Once the agreed purpose of returning the data has been achieved, the instruction terminates; deletion is carried out under Appendix No. 3 and the fact is recorded in form No. 10. This procedure does not mean that Markiro is obliged to store the whole of the Customer's production for every possible regulatory period. The Customer keeps the archives it needs in advance.",
        },
        {
          kind: "paragraph",
          text: "Special amendments to these regulations: [none / agreed description and reference to the order].",
        },
        SIGNATURES,
      ],
    },
  ];
}

function appendixThreeFourSections(fields: TenantAgreementFields): readonly AgreementSection[] {
  const number = agreementField(fields.number, "[number]");
  const conclusionDate = agreementDate(fields.conclusionDate, "[date of conclusion]");
  const { customer } = fields;
  const contractor = fields.contractor;

  return [
    {
      id: "prilozhenie-3",
      heading: "Appendix No. 3. Personal data processing instruction",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `To agreement No. ${number} of ${conclusionDate}. Individual instruction No. [number] of [date]. It is executed before the processing of the entrusted data begins.`,
        },
      ],
    },
    {
      id: "prilozhenie-3-roli",
      heading: "Appendix No. 3 · 1. Roles, subject matter and lawful grounds",
      blocks: [
        {
          kind: "paragraph",
          text: `3-A.1. The Customer — ${partyLine(customer, "[full name / sole proprietor's full name]")}, address ${agreementField(customer.address, "[address]")} — instructs ${partyLine(contractor, CONTRACTOR_DEFAULT_NAME)} to process the personal data listed below for the agreed Markiro functions. The Customer determines the purposes and the composition of the data and is the operator. The Contractor processes the data on documented instructions and acquires no authority to act as the Customer's representative.`,
        },
        {
          kind: "paragraph",
          text: "3-A.2. The Customer secures the grounds for processing and for transferring data for processing, informs the data subjects and obtains consents where the law requires them, including under part 3 of article 6 of Federal Law No. 152-FZ. The Customer's signature does not replace its employees' consents. Special categories of data, biometric data, health information, copies of identity documents and other excessive data are outside this instruction.",
        },
        {
          kind: "table",
          columns: ["Data subjects and data", "Purpose and limit"],
          columnRatios: [1.3, 1],
          rows: [
            [
              "Employees and operators: full name, position/unit where required, work contact, internal identifier, role, badge identifier.",
              "Identification of an authorised user and the assignment of access. Without facial recognition or other biometric methods.",
            ],
            [
              "Account attributes: login, protected authentication verification values, device binding; account activity.",
              "Login to the cabinet/client and the security of the entrusted processing. Plain passwords and the private keys of a qualified electronic signature are never included in documents or requests.",
            ],
            [
              "Employees' actions: date and time of the operation, shift, device, dispensing, stocktaking and adjustment data and the related internal identifier.",
              "Performance of production assignments and audit of operations. Not for independent profiling of employees by the Contractor.",
            ],
            [
              "Counterparties' contact persons, where used: full name, position, work telephone/e-mail; sole proprietor details to the extent required.",
              "The agreed exchange of information and the Customer's record of contacts. Not for mailings by the Contractor.",
            ],
            [
              "Agreed additions to the list",
              "[none / exact list, purpose and category of data subjects].",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "3-A.3. Permitted operations: receipt from the Customer and from agreed sources, recording, systematisation, accumulation, storage, updating, retrieval, use for the purposes listed, provision to authorised users and agreed recipients, blocking, deletion and destruction. Public dissemination and use in advertising or training datasets are not entrusted.",
        },
        {
          kind: "paragraph",
          text: "3-A.4. The method of processing is automated and, where agreed support is provided, mixed. The principal place of processing and the databases used for collecting, storing and other operations subject to localisation are in the Russian Federation. Cross-border transfer and remote access to the entrusted data from abroad are not permitted by this instruction; any change requires separate agreement and compliance with the law.",
        },
        {
          kind: "paragraph",
          text: "3-A.5. Processing begins: [date or event]. Term of the principal purpose: [the order period / a shorter agreed term]. After it ends, only the processing necessary for the agreed return of the data is permitted, for no more than 30 calendar days and while a lawful ground remains, after which the data is deleted. A shorter mandatory statutory period prevails.",
        },
      ],
    },
    {
      id: "prilozhenie-3-obyazannosti",
      heading: "Appendix No. 3 · 2. The Contractor's obligations and engaged persons",
      blocks: [
        {
          kind: "paragraph",
          text: "3-B.1. The Contractor observes the principles of processing and confidentiality and the requirements of part 5 of article 18 and of article 18.1 of Federal Law No. 152-FZ, and ensures the measures required by article 19. It restricts authority, separates cabinets' data, protects channels, manages access and backups, logs significant actions, remedies identified vulnerabilities and provides recovery within the agreed scope.",
        },
        {
          kind: "paragraph",
          text: "3-B.2. The applicable protection level, threat model and set of measures are determined before the production launch, having regard to the actual data and environment. The Customer supplies the necessary input information. The existence of the Agreement does not replace the implementation of measures or the mandatory documents. The Customer's special requirements: [none / list and agreed measures].",
        },
        {
          kind: "paragraph",
          text: "3-B.3. At the Customer's request, including before processing begins, the Contractor provides documents and information confirming compliance with the instruction within five working days, or sooner where a mandatory deadline requires it. Access to the evidence is arranged without disclosing other clients' data or secrets that are not needed for the check. Where an instruction is contradictory or apparently unlawful, the Contractor requests clarification and suspends only the disputed processing.",
        },
        {
          kind: "paragraph",
          text: "3-B.4. Only the engaged processors listed and agreed below are permitted, and only to the extent necessary. The Contractor imposes comparable obligations on them, monitors performance and is answerable to the Customer for the part entrusted. A blank line is not consent to an unknown recipient; the list is completed before data is transferred.",
        },
        {
          kind: "table",
          columns: [
            "Person / details",
            "Function and data accessible",
            "Territory / database addresses",
          ],
          columnRatios: [1.2, 1.6, 1.2],
          rows: [
            [
              "Infrastructure provider Yandex Cloud: [exact name, TIN and contract]",
              "[hosting of the database, objects and backups; the categories from section 1]",
              "Russian Federation; [region and addresses/list of sites per the provider's documents]",
            ],
            [
              "Corporate mail provider: [exact name, TIN and contract]",
              "[delivery of messages and correspondence; work contacts and the minimum content of requests]",
              "Russian Federation; [confirmed places of processing]",
            ],
            [
              "Other persons",
              "[none engaged / name, TIN, role, data]",
              "[territory and places of processing]",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "3-B.5. A new processor or a material extension of access is agreed in advance and documented. The Contractor sends the particulars at least 10 working days before the intended transfer; silence does not amount to consent. Cloud infrastructure the Contractor procures in order to perform the Agreement is not sold to the Customer as a separate third-party licence.",
        },
      ],
    },
    {
      id: "prilozhenie-3-intsidenty",
      heading: "Appendix No. 3 · 3. Incidents and assistance",
      blocks: [
        {
          kind: "paragraph",
          text: "3-B.6. The Contractor reports indications of an incident involving the entrusted data without undue delay and, where a case referred to in part 3.1 of article 21 of Federal Law No. 152-FZ is established, no later than 12 hours after detection. The 12-hour contractual period is set by the Parties and is shorter than the period the law allows the operator, so that the Customer has time to perform its own obligation. The available particulars of the time, nature, data affected, likely consequences and measures taken are reported; incomplete particulars are not a ground for waiting until the investigation is finished.",
        },
        {
          kind: "paragraph",
          text: "3-B.7. Supplements are provided as they become available. The Contractor preserves the evidence relating to the incident and helps the Customer prepare the mandatory notifications. As the operator, the Customer decides whether to notify the regulator and the data subjects; this does not remove the Contractor's own obligations. The incident notification period applies regardless of the ordinary support schedule.",
        },
      ],
    },
    {
      id: "prilozhenie-3-obrashcheniya",
      heading: "Appendix No. 3 · 4. Requests, return and deletion",
      blocks: [
        {
          kind: "paragraph",
          text: "3-C.1. The Contractor forwards data subjects' requests concerning the entrusted data to the Customer within one working day and takes no independent decision to grant them, except where the law obliges it to. On a documented instruction the Contractor assists with search, correction, blocking and deletion within a period that allows the Customer to meet its mandatory deadline; the ordinary period for assistance is three working days.",
        },
        {
          kind: "paragraph",
          text: "3-C.2. The Customer may give a lawful instruction to return and/or delete the data before the order ends. Such an instruction takes precedence over the ordinary export window. When the purpose ceases, the Contractor stops ordinary processing and destroys the data, including the copies under its control, no later than 30 calendar days, unless the law sets a shorter period or a separate lawful ground requires a limited part to be retained.",
        },
        {
          kind: "paragraph",
          text: "3-C.3. The ordinary backup cycle period: [period agreed with the infrastructure]. Copies are not used to continue ordinary processing of deleted data; on restoration the restrictions and deletions are applied again. Where timely destruction is technically impossible, this is documented and handled under part 6 of article 21 of Federal Law No. 152-FZ: the data is blocked and destroyed within the maximum period that provision sets. That exception is not a general permission to retain everything for six months.",
        },
        {
          kind: "paragraph",
          text: "3-C.4. The Contractor confirms the actions performed by a document in the form of Appendix No. 10. A return is confirmed by the set of files, the format, the date and the secure method of delivery; destruction is confirmed separately, after it has actually been completed. Confirming receipt of an export does not mean the data has already been deleted. If particular information must be retained, its composition, the ground, the restricted access and the period are stated.",
        },
        {
          kind: "paragraph",
          text: "3-C.5. For its own purposes of entering into and performing the Agreement, settlements, mandatory records, the protection of rights and the security of the platform, the Contractor may itself process the necessary information about representatives and settlements where a separate lawful ground exists. That processing is confined to the corresponding purpose and is disclosed in the privacy policy; it does not permit the whole production database to be retained in the guise of an accounting archive.",
        },
        {
          kind: "paragraph",
          text: "3-C.6. The Contractor does not use the entrusted data for advertising, for independent analysis of employees, for publication or for training external models, and does not transfer it to foreign support or development systems that have not been agreed. Diagnostics use minimal information and anonymised examples wherever possible.",
        },
      ],
    },
    {
      id: "prilozhenie-3-kontakty",
      heading: "Appendix No. 3 · 5. Contacts and special instructions",
      blocks: [
        {
          kind: "table",
          columns: ["Parameter", "Value"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "The Customer's person responsible for personal data",
              "[full name, position, e-mail, telephone for incidents]",
            ],
            [
              "The Contractor's contact",
              "Vladislav Sergeevich Bogatyrev; hello@v-b.tech; +7 934 355-14-90. Backup incident channel: [channel].",
            ],
            [
              "The Customer's lawful grounds and notices",
              "[description of the grounds; particulars of the consents/notices required; do not attach excessive copies of subjects' data]",
            ],
            ["Special instructions", "[none / composition, date and signed document]"],
            [
              "Processing readiness check",
              "[date on which the hosting location, the list of processors and the protective measures were confirmed]",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "This instruction does not transfer to the Contractor the functions of an employer, authority to act as a representative in Chestny ZNAK, or the right to sign documents with the Customer's qualified electronic signature. A separate signature signifies agreement to the purposes, lists and terms of the instruction, and not the issue of a power of attorney.",
        },
        PROCESSING_SIGNATURES,
      ],
    },
    {
      id: "prilozhenie-4",
      heading: "Appendix No. 4. Assignment for services / works",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `To agreement No. ${number} of ${conclusionDate}. Assignment No. [number] of [date], under order No. [number / not applicable].`,
        },
      ],
    },
    {
      id: "prilozhenie-4-sostav",
      heading: "Appendix No. 4 · 1. Composition of the assignment",
      blocks: [
        {
          kind: "table",
          columns: ["Condition", "Agreed description"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "Subject matter",
              "[exact name of the service or work from the catalogue; not merely the name of a package]",
            ],
            [
              "Type of performance",
              "[one-off service / hourly services / work with a result / retainer support / author's commission — select whichever applies]",
            ],
            ["Initial state and task", "[the problem and the expected result]"],
            [
              "Cabinet, equipment and versions",
              "[tenant ID, models, operating system, 1C, Markiro version; for handheld terminals, the verified modes]",
            ],
            [
              "Input data and cooperation",
              "[what the Customer provides and by what date; the secure method of delivering access]",
            ],
            [
              "Composition and limit of scope",
              "[actions; number of devices/rows/templates; hour limit; exclusions stated separately]",
            ],
            [
              "Result and delivery",
              "[files, version, configuration, document, demonstration; place of delivery]",
            ],
            [
              "Acceptance criteria",
              "[verifiable scenarios, input data, expected results, permissible deviations]",
            ],
            [
              "Deadlines",
              "Start: [date/condition]. Completion: [exact date]. Stages: [dates and results]. For an author's commission, having regard to the applicable rules of the Civil Code of the Russian Federation.",
            ],
            [
              "Price and settlements",
              "[fixed price / rate × volume with a cap]; prepayment [amount/%]; balance [condition]. Without VAT where the tax on professional income applies.",
            ],
            [
              "Amendment of the assignment",
              "Only before the additional performance, through an agreed amendment with a new price/deadline.",
            ],
            [
              "Not included",
              "[repair of hardware, issue of a qualified electronic signature, third-party licences, new features and other specific exclusions].",
            ],
          ],
        },
      ],
    },
    {
      id: "prilozhenie-4-abonement",
      heading: "Appendix No. 4 · 2. Retainer support",
      blocks: [
        {
          kind: "paragraph",
          text: "To be completed only for a retainer model. Package: [name]. Period: [exact dates]. Retainer fee: [amount] RUB. Included: [number] minutes. Schedule and channel: [terms]. Carry-over of the balance: [none / rule]. Additional rate: [amount] RUB per hour; additional work only after agreement. Recording of actual time: minutes per request, without automatic rounding up to a full hour.",
        },
        {
          kind: "paragraph",
          text: "The report is prepared in the form of Appendix No. 8. If the retainer model field is not completed, no monthly fee and no obligation to provide such a package arise.",
        },
      ],
    },
    {
      id: "prilozhenie-4-rezultaty",
      heading: "Appendix No. 4 · 3. Terms concerning protected results",
      blocks: [
        {
          kind: "paragraph",
          text: "To be completed where a protected result is created or transferred. For ordinary installation or consultancy, state “Not applicable”. Transferring the right to a result does not replace the Markiro and 1C licences the Customer requires.",
        },
        {
          kind: "table",
          columns: ["Condition", "Agreed value"],
          columnRatios: [1, 2.4],
          rows: [
            ["Protected result", "[name of the work/program/template, version and identification]"],
            [
              "Author and right holder",
              "The author is Vladislav Sergeevich Bogatyrev. The exclusive right remains with the Contractor. Anything else applies only if stated here: [not applicable / description].",
            ],
            [
              "Previously created components",
              "Markiro and its modules, libraries and templates created before this assignment. The exclusive right to them is not alienated and they do not form part of the result.",
            ],
            [
              "Rights granted",
              "A simple (non-exclusive) licence. The exclusive right is not assigned; another regime applies only if expressly agreed here: [not applicable / description].",
            ],
            [
              "Methods of use",
              "Installation, launch, reproduction in the memory of the Customer's devices and printing within the Customer's own activity. Modification, decompilation, distribution and sub-licensing are [not granted / exact list].",
            ],
            [
              "Term and territory",
              "The term runs with the current Markiro licence unless another is stated here: [not applicable / exact term]. Territory: the Russian Federation.",
            ],
            ["Fee for creation", "[amount] RUB."],
            [
              "Fee for the rights",
              "Included in the assignment total and not charged separately unless stated otherwise here: [not applicable / amount and terms]. Where it is 0 RUB, state expressly that the corresponding grant is free of charge.",
            ],
            [
              "Source code / editable file",
              "Not delivered. Anything else applies only if stated here: [not applicable / exact composition and manner of delivery].",
            ],
            [
              "Condition for the licence to the result to begin",
              "Delivery of the result and payment of the assignment in full.",
            ],
            [
              "Use after the subscription ends",
              "A result embedded in Markiro works only while a licence is valid. A standalone result: [not applicable / permitted methods]. Access to the Markiro service is provided separately and is not extended by this assignment.",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "Where a new work is commissioned from the author personally, this assignment together with the Agreement determines the corresponding terms of the author's commission. The Parties do not apply the rules on the alienation of rights to it arbitrarily merely because the work has been paid for. The essential terms are completed before the creation of the result begins.",
        },
      ],
    },
    {
      id: "prilozhenie-4-soglasovanie",
      heading: "Appendix No. 4 · 4. Confirmation of agreement",
      blocks: [
        {
          kind: "paragraph",
          text: "The Parties have agreed the scope and acceptance criteria stated above. Persons responsible for the technical check: for the Contractor — [full name]; for the Customer — [full name, contact]. The right to accept a technical result does not of itself confer the right to change the price or to sign an agreement on behalf of the organisation.",
        },
        {
          kind: "paragraph",
          text: "Materials attached: [specification, sample files, list of scenarios, version number].",
        },
        SIGNATURES,
      ],
    },
  ];
}

function appendixNineTenSections(fields: TenantAgreementFields): readonly AgreementSection[] {
  const number = agreementField(fields.number, "[number]");
  const conclusionDate = agreementDate(fields.conclusionDate, "[date of conclusion]");
  const { customer } = fields;
  const contractor = fields.contractor;

  return [
    {
      id: "prilozhenie-9",
      heading: "Appendix No. 9. Contacts and electronic interaction",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `To agreement No. ${number} of ${conclusionDate}.`,
        },
      ],
    },
    {
      id: "prilozhenie-9-litsa",
      heading: "Appendix No. 9 · 1. Authorised persons and channels",
      blocks: [
        {
          kind: "table",
          columns: ["Party and person", "Authority", "Personal channel / identifier"],
          columnRatios: [1.2, 1.8, 1.2],
          rows: [
            [
              "Contractor: Vladislav Sergeevich Bogatyrev",
              "Signing of contractual and primary documents; technical approvals.",
              "hello@v-b.tech; +7 934 355-14-90; EDM ID [ID / not connected].",
            ],
            [
              "Customer: [full name, position]",
              "[agreement, orders, statements; basis of authority; monetary limit].",
              "[individual e-mail, telephone, EDM ID].",
            ],
            [
              "Customer: [administrator's full name]",
              "Technical tasks and access. Financial obligations only where the authority is stated expressly.",
              "[individual e-mail / account].",
            ],
            [
              "Contacts for data incidents",
              "[responsible persons and a backup channel].",
              "[e-mail and telephone].",
            ],
          ],
        },
        {
          kind: "paragraph",
          text: "9-A.1. The basic method of signature is paper with handwritten signatures or electronic document management with an enhanced qualified electronic signature. The Agreement itself, the original Appendix No. 9 and any change of bank details or signatories are executed by those methods unless the Parties have separately agreed another reliable identification procedure.",
        },
        {
          kind: "paragraph",
          text: "9-A.2. Technical correspondence is permitted through the channels listed. A cabinet administrator does not acquire the right to enter into transactions merely by virtue of a technical role. The list of signatories and their authority is checked before a signature is accepted; a shared departmental mailbox without an identified signatory is not used for a simple electronic signature.",
        },
      ],
    },
    {
      id: "prilozhenie-9-pep",
      heading: "Appendix No. 9 · 2. Enabling the simple electronic signature by e-mail",
      blocks: [
        {
          kind: "callout",
          tone: "warning",
          text: "By default the simple electronic signature is NOT ENABLED. Simple electronic signature mode: [not enabled / enabled]. Permitted documents: [list]. Monetary limit for a single obligation: [amount] RUB. If the mode, the signatory, the individual address or the limit is undefined, the simple electronic signature does not apply. The limit does not restrict the validity of an enhanced qualified electronic signature where the corresponding authority exists.",
        },
        {
          kind: "paragraph",
          text: "9-A.3. Where the mode is enabled, the Parties recognise the simple electronic signature described below as equivalent to a handwritten signature for the selected documents. The key of the simple electronic signature consists of the confidential means of access to the individual mailbox of the person named. The user must protect that access and must not pass it to anyone else; two-factor authentication is used where technically possible.",
        },
        {
          kind: "paragraph",
          text: "9-A.4. The signatory sends, from the agreed individual address, a message with the unaltered document file and the text: “I sign [type, number, date, version of the document, name of the attached file] on behalf of [Party]. [Full name, position, basis of authority]”. For a bilateral document the other Party confirms the same version in the same way. A brief “OK”, a forwarded message or an automatic reply is not a signature.",
        },
      ],
    },
    {
      id: "prilozhenie-9-dokazatelstva",
      heading: "Appendix No. 9 · 3. Verification and evidence",
      blocks: [
        {
          kind: "paragraph",
          text: "9-B.1. The signatory is identified by the combination of the approved individual address, the particulars of the person contained in the message, that person's authority and the link between the message and the exact unaltered attachment. The recipient checks the address and the technical indicators of the sender and compares the file with the agreed version. Where the authenticity or the authority is in doubt, the document is confirmed by an enhanced qualified electronic signature or on paper before the disputed obligation is performed.",
        },
        {
          kind: "paragraph",
          text: "9-B.2. The Parties retain the original e-mail message with its technical headers, the attached file and the other Party's confirmation; that set constitutes the evidence of the simple electronic signature. Altering the attachment creates a new version that must be signed again. Where only scanned copies are exchanged, the paper original is kept by the signing Party and produced on a reasoned request.",
        },
        {
          kind: "paragraph",
          text: "9-B.3. Automatically inserting an image of the other Party's signature into an invoice or a statement is not permitted. The system may record the fact of signature and its source, but must not create a signature that does not exist. The date of drawing up, the date of performance and the date of signature are stored separately where they differ.",
        },
        {
          kind: "paragraph",
          text: "9-B.4. A Party gives notice of a loss of access, a compromised key, a signatory's departure or a revocation of authority without undue delay through the confirmed backup channel. Once such notice is received, new simple electronic signatures from that person are no longer accepted until the arrangement is agreed afresh. A notice of change arriving only from the compromised mailbox is not sufficient confirmation of a new address.",
        },
        {
          kind: "paragraph",
          text: "9-B.5. For notices and claims, confirmation of delivery is assessed under the terms of the Agreement. Placing a file in the cabinet counts as delivery only where that method has been agreed in advance, the addressee is identified and confirmation is available. Technical logs are not treated as conclusive evidence in advance.",
        },
      ],
    },
    {
      id: "prilozhenie-9-svedeniya",
      heading: "Appendix No. 9 · 4. Additional particulars",
      blocks: [
        {
          kind: "table",
          columns: ["Condition", "To be completed"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "Electronic document management operator and identifiers",
              "[Party, operator, ID; or paper document flow]",
            ],
            [
              "Documents permitted with a simple electronic signature",
              "[for example orders, assignments, statements; or the simple electronic signature is not enabled]",
            ],
            [
              "Address for invoices and receipts",
              "[e-mail of the accounts department/authorised person]",
            ],
            [
              "Backup confirmation channel",
              "[telephone / enhanced qualified electronic signature / in-person delivery]",
            ],
            ["Date the agreed authority takes effect", "[date]"],
          ],
        },
        {
          kind: "paragraph",
          text: "Any change to the terms of this appendix is made by a signed document. It has no retroactive effect on messages already received and does not validate the signature of a person who in fact had no authority.",
        },
        SIGNATURES,
      ],
    },
    {
      id: "prilozhenie-10",
      heading: "Appendix No. 10. Form of confirmation of data transfer and deletion",
      startsPage: true,
      blocks: [
        {
          kind: "paragraph",
          text: `CONFIRMATION No. [number] of [date of drawing up]. Agreement No. ${number}; instruction No. [number]; cabinet [tenant ID]. Ground: [end of the order / the Customer's written instruction No. ...]. Contractor: ${partyName(contractor, CONTRACTOR_DEFAULT_NAME)}. Customer: ${partyLine(customer, "[full name / sole proprietor's full name]")}.`,
        },
        {
          kind: "table",
          columns: ["A. Data transfer — after the transfer has taken place", "Actual value"],
          columnRatios: [1, 2.4],
          rows: [
            [
              "Composition and period of the data",
              "[objects, reports, period; information excluded and the ground]",
            ],
            ["Format and identifiers", "[formats, file names, size; checksums where available]"],
            [
              "When and how delivered",
              "[date, secure channel; recipient; how long the link remains accessible]",
            ],
            ["Confirmation of receipt", "[date and method of confirmation / not yet received]"],
          ],
        },
        {
          kind: "table",
          columns: [
            "B. Deletion — completed separately, after it has been carried out",
            "Actual value",
          ],
          columnRatios: [1, 2.4],
          rows: [
            ["Ground and scope of deletion", "[instruction, categories of data and systems]"],
            ["Principal stores", "[what was deleted; date; method of verification]"],
            [
              "Copies / engaged processors",
              "[date of deletion, confirmation; or blocking, the reason, the lawful ground and the final deadline]",
            ],
            [
              "Particular information retained",
              "[none / list, lawful ground, access and retention period]",
            ],
            [
              "Information remaining with the Customer",
              "Local copies on the Customer's devices are deleted or retained by the Customer on its own lawful grounds.",
            ],
          ],
        },
        {
          kind: "callout",
          tone: "warning",
          text: "A section that has not been carried out is marked “Not performed as at the date of this document” and is not signed as performed. Receiving an export does not mean deletion has occurred; deletion does not mean the Customer has received the file. For deletion, a new document or a signed supplement is drawn up after it has actually been completed.",
        },
        TRANSFER_SIGNATURES,
      ],
    },
  ];
}

/**
 * The English sections of the standard Markiro client agreement.
 *
 * Translation lands section group by section group. Anything not yet
 * translated falls through to the Russian text, so the tree is always the
 * Russian tree with some sections substituted — same ids, same order, same
 * block shapes. That keeps `pairLocaleContent` satisfied from the first
 * commit, which is what makes the translation reviewable in pieces instead of
 * one unreadable leap.
 *
 * The four sections in `AGREEMENT_MONOLINGUAL_SECTION_IDS` fall through
 * permanently: they are Russian accounting forms.
 */
export function buildEnAgreementSections(
  fields: TenantAgreementFields,
): readonly AgreementSection[] {
  const translated = new Map<string, AgreementSection>(
    [
      ...bodySections(fields),
      ...appendixOneTwoSections(fields),
      ...appendixThreeFourSections(fields),
      ...appendixNineTenSections(fields),
    ].map((section) => [section.id, section]),
  );
  return buildRuAgreementSections(fields).map((section) => translated.get(section.id) ?? section);
}
