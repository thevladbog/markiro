export type LegalLocale = "ru" | "en";

export type LegalDocumentCode = "MKR-PD-01" | "MKR-PD-02" | "MKR-DPA-01" | "MKR-BRD-01";

export type LegalDocumentStatus = "draft" | "active" | "superseded" | "withdrawn";

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

export interface LegalDocumentRelease {
  readonly code: LegalDocumentCode;
  readonly revision: `${number}.${number}.${number}`;
  readonly effectiveDate: `${number}-${number}-${number}`;
  readonly status: LegalDocumentStatus;
  readonly operatorProfileId: "operator-2026-08-15";
  readonly routes: Readonly<Record<LegalLocale, `/${string}/`>>;
  readonly supersedes?: `${LegalDocumentCode}/${number}.${number}.${number}`;
}

export interface LegalOperatorProfile {
  readonly name: string;
  readonly address: string;
  readonly email: string;
  readonly phone: string;
  readonly site: `https://${string}`;
}
