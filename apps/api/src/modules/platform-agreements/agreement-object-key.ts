const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Three exact shapes, nothing else. The object store allowlists key
// namespaces, so a loose `agreements/` prefix would widen that control.
const AGREEMENT_KEY = new RegExp(
  `^agreements/${UUID}/(?:draft\\.docx|signed-[0-9a-f]{64}\\.docx|attachments/${UUID})$`,
);

export function isAgreementObjectKey(key: string): boolean {
  return AGREEMENT_KEY.test(key);
}

export function agreementDraftObjectKey(agreementId: string): string {
  return assertKey(`agreements/${agreementId}/draft.docx`);
}

export function agreementSignedObjectKey(agreementId: string, sha256: string): string {
  return assertKey(`agreements/${agreementId}/signed-${sha256}.docx`);
}

export function agreementAttachmentObjectKey(agreementId: string, attachmentId: string): string {
  return assertKey(`agreements/${agreementId}/attachments/${attachmentId}`);
}

function assertKey(key: string): string {
  if (!isAgreementObjectKey(key)) throw new Error("Unsafe object key");
  return key;
}
