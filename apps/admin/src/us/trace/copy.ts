const en = {
  sourceMissing: "Source missing",
  location: "Location",
  reference: "Reference",
  title: "Trace",
  search: "Search lots",
  lot: "Lot",
  choose: "Choose a lot",
  idle: "Select a lot to start tracing.",
  direction: "Direction",
  backward: "Backward",
  forward: "Forward",
  both: "Both",
  depth: "Maximum depth",
  graph: "Graph",
  table: "Table",
  tabs: "Trace presentation",
  loading: "Loading…",
  retry: "Retry trace",
  unavailable: "Trace unavailable. Please retry.",
  invalid_input: "Check the trace or search input.",
  trace_lot_not_found: "Lot not found or unavailable to this organization.",
  forbidden: "Access is no longer available.",
  session_required: "Your session has ended.",
  complete: "Current trace complete",
  incomplete: "Trace incomplete",
  nodes: "nodes",
  edges: "edges",
  depthLimit: "depth",
  gap: "Origin gap",
  excluded: "Excluded in this trace scope",
  history: "Excluded history",
  historyHint: "Excluded revisions are separate from the current trace and its counts.",
  historyError: "History unavailable. Please retry.",
  historyRetry: "Retry history",
  historyEmpty: "No excluded history.",
  previous: "Previous",
  next: "Next",
  revision: "revision",
  predecessor: "Predecessor",
  successor: "Successor",
  draft: "Draft",
  amended: "Amended",
  void: "Void",
  searchError: "Lot search unavailable. Please retry.",
  noHits: "No matching lots.",
  clear: "Clear search",
  searchPages: "Lot search pages",
  historyPages: "History pages",
};
const es: typeof en = {
  sourceMissing: "Origen ausente",
  location: "Ubicación",
  reference: "Referencia",
  title: "Trazabilidad",
  search: "Buscar lotes",
  lot: "Lote",
  choose: "Elegir un lote",
  idle: "Seleccione un lote para iniciar la trazabilidad.",
  direction: "Dirección",
  backward: "Hacia atrás",
  forward: "Hacia adelante",
  both: "Ambas",
  depth: "Profundidad máxima",
  graph: "Gráfico",
  table: "Tabla",
  tabs: "Presentación de trazabilidad",
  loading: "Cargando…",
  retry: "Reintentar trazabilidad",
  unavailable: "Trazabilidad no disponible. Vuelva a intentarlo.",
  invalid_input: "Revise los datos de trazabilidad o búsqueda.",
  trace_lot_not_found: "Lote no encontrado o no disponible para esta organización.",
  forbidden: "El acceso ya no está disponible.",
  session_required: "Su sesión ha finalizado.",
  complete: "Trazabilidad actual completa",
  incomplete: "Trazabilidad incompleta",
  nodes: "nodos",
  edges: "conexiones",
  depthLimit: "profundidad",
  gap: "Falta de origen",
  excluded: "Excluidos en este alcance de trazabilidad",
  history: "Historial excluido",
  historyHint:
    "Las revisiones excluidas están separadas de la trazabilidad actual y sus recuentos.",
  historyError: "Historial no disponible. Vuelva a intentarlo.",
  historyRetry: "Reintentar historial",
  historyEmpty: "Sin historial excluido.",
  previous: "Anterior",
  next: "Siguiente",
  revision: "revisión",
  predecessor: "Predecesor",
  successor: "Sucesor",
  draft: "Borrador",
  amended: "Corregido",
  void: "Anulado",
  searchError: "Búsqueda de lotes no disponible. Vuelva a intentarlo.",
  noHits: "No hay lotes coincidentes.",
  clear: "Limpiar búsqueda",
  searchPages: "Páginas de búsqueda de lotes",
  historyPages: "Páginas del historial",
};
export const traceCopy = (language: string) => (language.startsWith("es") ? es : en);
export function traceError(error: unknown): keyof typeof en {
  if (
    error instanceof Error &&
    ["invalid_input", "trace_lot_not_found", "forbidden", "session_required"].includes(
      error.message,
    )
  ) {
    switch (error.message) {
      case "invalid_input":
        return "invalid_input";
      case "trace_lot_not_found":
        return "trace_lot_not_found";
      case "forbidden":
        return "forbidden";
      case "session_required":
        return "session_required";
    }
  }
  return "unavailable";
}
