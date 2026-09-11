import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderLegalDocxBilingual,
  renderLegalDocxDraft,
  type LegalDocxBilingual,
  type LegalDocxDraft,
} from "../artifacts/docx.js";
import { buildTenantAgreement } from "../documents/tenant-agreement.js";
import {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "../documents/tenant-agreement-bilingual.js";
import type { TenantAgreementFields } from "../documents/tenant-agreement-fields.js";
import { TENANT_AGREEMENT_PASSPORT_CONTENT } from "../documents/tenant-agreement-passport.js";

// Local-only preview of the draft client agreement. These documents are not
// registry releases: they have no landing route, no PDF, no artifact manifest
// entry and no attestation. `verify-artifacts` and the production bundle
// contract stay unaware of them by design.
const DRAFT_REVISION = "2026.09/01";
const DRAFT_EFFECTIVE_DATE = "2026-09-10";
// The draft has no /d/ verification page, so the Data Matrix points at the
// published registry instead of a URL that would 404.
const REGISTRY_URL = "https://markiro.app/legal/";

// An entirely unfilled customer keeps every square-bracket placeholder,
// which is exactly what the blank template should print.
const EMPTY_CUSTOMER = {
  kind: "legal_entity",
  name: "",
  inn: null,
  kpp: null,
  ogrn: null,
  address: null,
  email: null,
  phone: null,
  bankName: null,
  bic: null,
  settlementAccount: null,
  correspondentAccount: null,
  taxRegime: null,
} as const satisfies TenantAgreementFields["customer"];

interface DraftArtifact {
  readonly fileName: string;
  readonly draft: LegalDocxDraft;
}

interface BilingualArtifact {
  readonly fileName: string;
  readonly draft: LegalDocxBilingual;
}

const BILINGUAL_DRAFTS: readonly BilingualArtifact[] = [
  {
    fileName: "markiro_mkr-agr-01_2026.09-01_ru-en_draft.docx",
    draft: {
      code: "MKR-AGR-01",
      revision: DRAFT_REVISION,
      effectiveDate: DRAFT_EFFECTIVE_DATE,
      locale: "ru",
      verificationUrl: REGISTRY_URL,
      classLabel: "ПРОЕКТ ДОГОВОРА",
      operatorProfileId: "operator-2026-08-15",
      content: pairLocaleContent(
        buildTenantAgreement({ customer: EMPTY_CUSTOMER }, "ru"),
        buildTenantAgreement({ customer: EMPTY_CUSTOMER }, "en"),
        AGREEMENT_MONOLINGUAL_SECTION_IDS,
      ),
    },
  },
];

const DRAFTS: readonly DraftArtifact[] = [
  {
    fileName: "markiro_mkr-agr-01_2026.09-01_ru_draft.docx",
    draft: {
      code: "MKR-AGR-01",
      revision: DRAFT_REVISION,
      effectiveDate: DRAFT_EFFECTIVE_DATE,
      locale: "ru",
      verificationUrl: REGISTRY_URL,
      classLabel: "ПРОЕКТ ДОГОВОРА",
      operatorProfileId: "operator-2026-08-15",
      content: buildTenantAgreement({ customer: EMPTY_CUSTOMER }, "ru"),
    },
  },
  {
    fileName: "markiro_mkr-agr-01_2026.09-01_ru_passport_internal.docx",
    draft: {
      code: "MKR-AGR-01-INT",
      revision: DRAFT_REVISION,
      effectiveDate: DRAFT_EFFECTIVE_DATE,
      locale: "ru",
      verificationUrl: REGISTRY_URL,
      classLabel: "ВНУТРЕННИЙ ДОКУМЕНТ",
      operatorProfileId: "operator-2026-08-15",
      content: TENANT_AGREEMENT_PASSPORT_CONTENT,
    },
  },
];

function parseOutDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out-dir");
  if (index < 0) {
    // dist/cli/../../.local and src/cli/../../.local both resolve to the
    // package root, so the default works compiled and under tsx alike.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.local");
  }
  const value = argv[index + 1];
  if (!value) throw new Error("--out-dir requires a path");
  return path.resolve(value);
}

export async function renderAgreementDrafts(outDir: string): Promise<readonly string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const { fileName, draft } of DRAFTS) {
    const target = path.join(outDir, fileName);
    await writeFile(target, await renderLegalDocxDraft(draft));
    written.push(target);
  }
  for (const { fileName, draft } of BILINGUAL_DRAFTS) {
    const target = path.join(outDir, fileName);
    await writeFile(target, await renderLegalDocxBilingual(draft));
    written.push(target);
  }
  return written;
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const outDir = parseOutDir(process.argv.slice(2));
  const written = await renderAgreementDrafts(outDir);
  for (const target of written) process.stdout.write(`${target}\n`);
}
