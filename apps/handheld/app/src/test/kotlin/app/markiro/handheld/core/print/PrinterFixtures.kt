package app.markiro.handheld.core.print

/** Printing fixtures explicitly configure every purpose; selected is no longer a route. */
suspend fun PrinterDao.upsertAssigned(printer: PrinterEntity) {
    upsert(printer)
    PrintPurpose.entries.forEach { assign(PrinterAssignmentEntity(it.wire, printer.id)) }
}
