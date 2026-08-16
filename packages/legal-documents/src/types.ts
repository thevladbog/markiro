import type { LegalIdentity, LegalRevision } from "./identity.js";

export type { LegalIdentity, LegalRevision } from "./identity.js";

export type LegalLocale = "ru" | "en";

export type LegalDocumentCode = "MKR-PD-01" | "MKR-PD-02" | "MKR-DPA-01" | "MKR-BRD-01";

export type LegalDocumentStatus = "draft" | "active" | "superseded" | "withdrawn";

export type LegalOperatorProfileId = "operator-2026-08-15";

export type LegalBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "ordered-list" | "unordered-list"; readonly items: readonly string[] }
  | {
      readonly kind: "definition-list";
      readonly items: readonly { readonly term: string; readonly detail: string }[];
    };

export interface LegalDocumentLocaleContent {
  readonly locale: LegalLocale;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly blocks: readonly LegalBlock[];
  }[];
}

export interface LegalDocumentRelease extends LegalIdentity {
  readonly code: LegalDocumentCode;
  readonly revision: LegalRevision;
  readonly status: LegalDocumentStatus;
  readonly operatorProfileId: LegalOperatorProfileId;
  readonly routes: Readonly<Record<LegalLocale, `/${string}/`>>;
  readonly supersedes?: `${LegalDocumentCode}/${LegalRevision}`;
}

export interface LegalDocumentSource {
  readonly releaseKey: `${LegalDocumentCode}/${LegalRevision}`;
  readonly content: Readonly<Record<LegalLocale, LegalDocumentLocaleContent>>;
}

export interface LegalOperatorProfile {
  readonly name: string;
  readonly address: string;
  readonly email: string;
  readonly phone: string;
  readonly site: `https://${string}`;
}
