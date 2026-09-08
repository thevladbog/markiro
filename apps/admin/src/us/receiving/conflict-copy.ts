export const receivingConflictCopy = {
  "en-US": {
    pending:
      "A correction draft is already pending. Reload this receipt, then open the pending correction to review or cancel it.",
    lifecycle:
      "The receipt lifecycle has changed. Reload the record to see its current status before starting another operation.",
    identity:
      "Retained lot identity cannot be changed. The fields below are locked. Keep a copy of any unsaved changes, then reload the record before continuing.",
    fields: {
      previousLineNo: "Previous revision line",
      lotId: "Lot",
      productId: "Product",
      tlc: "Lot code (TLC)",
      source: "TLC source",
      lotLinkMode: "Lot linking mode",
      receiptHandling: "Receipt handling",
    },
  },
  "es-US": {
    pending:
      "Ya hay un borrador de corrección pendiente. Recarga esta recepción y abre la corrección pendiente para revisarla o cancelarla.",
    lifecycle:
      "El estado de la recepción ha cambiado. Recarga el registro para ver su estado actual antes de iniciar otra operación.",
    identity:
      "No se puede cambiar la identidad del lote conservado. Los campos indicados están bloqueados. Guarda una copia de los cambios sin guardar y recarga el registro antes de continuar.",
    fields: {
      previousLineNo: "Línea de la revisión anterior",
      lotId: "Lote",
      productId: "Producto",
      tlc: "Código de lote (TLC)",
      source: "Origen del TLC",
      lotLinkMode: "Modo de vinculación del lote",
      receiptHandling: "Tratamiento de la recepción",
    },
  },
} as const;
