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

function representative(signatory: AgreementSignatory | undefined): string {
  return [signatory?.position, signatory?.fullName, signatory?.authorityBasis]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
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
    `represented by ${agreementField(representative(signatory), "[position, full name, basis of authority]")}, ` +
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
          text: '1.4. The "Customer\'s cabinet" (tenant) means the separate area of data and settings of a single Customer within the Markiro service. A tenant is not an independent party to the Agreement. Affiliated companies and other TINs do not automatically obtain access to the Customer\'s data and rights.',
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
          text: "8.2. The instruction to process personal data is documented by Appendix No. 3 before production personal data is uploaded. The Customer is the controller of the data entrusted; the Contractor is the person processing it on the Customer's instruction. For its own settlements and mandatory records the Contractor acts in its own capacity on a separate lawful basis.",
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
    bodySections(fields).map((section) => [section.id, section]),
  );
  return buildRuAgreementSections(fields).map((section) => translated.get(section.id) ?? section);
}
