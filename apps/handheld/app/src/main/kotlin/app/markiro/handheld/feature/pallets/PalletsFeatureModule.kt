package app.markiro.handheld.feature.pallets

import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PalletPrinter
import app.markiro.handheld.core.box.PrintOutcome
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.pallets.AttachResult
import app.markiro.handheld.core.pallets.PalletBootstrapMirror
import app.markiro.handheld.core.pallets.WarehousePallets
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.writeoff.MirrorOutcome
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.flow.Flow
import javax.inject.Singleton

/**
 * Everything the «Паллеты» mode needs, behind one seam so its ViewModel is
 * testable without Room, the printer or the network.
 */
interface PalletsGateway {
    /** Null when the bootstrap has never covered this operator: unknown, not refused. */
    suspend fun canBuildPallets(operatorId: String): Boolean?

    /** True once the pallet bootstrap has landed at least once. */
    suspend fun bootstrapReady(): Boolean

    val stampAt: Flow<Long?>

    suspend fun refresh(): MirrorOutcome

    fun observeOpen(): Flow<PalletEntity?>

    /** «Другой принтер» on a failed pallet label needs the device's own profiles. */
    fun observePrinters(): Flow<List<PrinterEntity>>

    fun observeMembers(palletId: String): Flow<List<PalletMembershipEntity>>

    /** Only the rejections the operator has not yet dismissed. */
    fun observeRejections(palletId: String): Flow<List<PalletMembershipEntity>>

    suspend fun capacity(pallet: PalletEntity): Int?

    suspend fun productName(productId: String): String?

    suspend fun attach(sscc: String, operatorId: String?): AttachResult

    suspend fun remove(palletId: String, sscc: String): Boolean

    suspend fun close(operatorId: String?): ClosePalletResult

    suspend fun acknowledge(palletId: String)

    suspend fun print(palletId: String, replacementPrinterId: String?, allowUnknown: Boolean): PrintOutcome

    suspend fun resolveUnknownAsPrinted(palletId: String)

    suspend fun defer(palletId: String)

    suspend fun reprintPallet(palletId: String, reason: ReprintReason, operatorId: String?, deviceId: String?)

    suspend fun deviceId(): String?

    fun nudgeSync()
}

/**
 * The Room/printer-backed gateway.
 *
 * A thin delegation on purpose: the pallet rules live in `WarehousePallets`,
 * the label in `PalletPrinter` and the audit trail in `ExceptionEngine`, and
 * none of them should be re-implemented here just because the UI needs them.
 */
class PalletsRepository(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val pallets: WarehousePallets,
    private val mirror: PalletBootstrapMirror,
    private val printer: PalletPrinter,
    private val exceptions: ExceptionEngine,
    private val sync: SyncEngine,
) : PalletsGateway {
    override suspend fun canBuildPallets(operatorId: String): Boolean? =
        db.palletPermissionDao().get(operatorId)?.canBuildPallets

    override suspend fun bootstrapReady(): Boolean = meta.get(MetaStore.PALLET_BOOTSTRAP_AT) != null

    override val stampAt: Flow<Long?> get() = mirror.stampAt

    override suspend fun refresh(): MirrorOutcome = mirror.refresh()

    override fun observeOpen(): Flow<PalletEntity?> = pallets.observeOpen()

    override fun observePrinters(): Flow<List<PrinterEntity>> = db.printerDao().observeAll()

    override fun observeMembers(palletId: String): Flow<List<PalletMembershipEntity>> =
        db.palletMembershipDao().observeByPallet(palletId)

    override fun observeRejections(palletId: String): Flow<List<PalletMembershipEntity>> =
        db.palletMembershipDao().observeUnacknowledgedRejections(palletId)

    override suspend fun capacity(pallet: PalletEntity): Int? = pallets.capacity(pallet)

    override suspend fun productName(productId: String): String? = db.palletProductDao().byId(productId)?.name

    override suspend fun attach(sscc: String, operatorId: String?): AttachResult = pallets.attach(sscc, operatorId)

    override suspend fun remove(palletId: String, sscc: String): Boolean = pallets.remove(palletId, sscc)

    override suspend fun close(operatorId: String?): ClosePalletResult = pallets.close(operatorId)

    override suspend fun acknowledge(palletId: String) = pallets.acknowledgeRejections(palletId)

    override suspend fun print(palletId: String, replacementPrinterId: String?, allowUnknown: Boolean): PrintOutcome =
        printer.print(palletId, replacementPrinterId, allowUnknown)

    override suspend fun resolveUnknownAsPrinted(palletId: String) = printer.resolveUnknownAsPrinted(palletId)

    override suspend fun defer(palletId: String) = printer.defer(palletId)

    /** A warehouse pallet has no shift, so the exception is queued without one. */
    override suspend fun reprintPallet(palletId: String, reason: ReprintReason, operatorId: String?, deviceId: String?) =
        exceptions.reprintPallet(null, palletId, reason, operatorId, deviceId)

    override suspend fun deviceId(): String? = pallets.deviceId()

    override fun nudgeSync() = sync.nudge()
}

@Module
@InstallIn(SingletonComponent::class)
object PalletsFeatureModule {
    @Provides
    @Singleton
    fun palletsGateway(
        db: HandheldDatabase,
        meta: MetaStore,
        pallets: WarehousePallets,
        mirror: PalletBootstrapMirror,
        printer: PalletPrinter,
        exceptions: ExceptionEngine,
        sync: SyncEngine,
    ): PalletsGateway = PalletsRepository(db, meta, pallets, mirror, printer, exceptions, sync)
}
