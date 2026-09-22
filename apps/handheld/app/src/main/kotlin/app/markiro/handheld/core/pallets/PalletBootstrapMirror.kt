package app.markiro.handheld.core.pallets

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.storage.PalletPermissionEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import app.markiro.handheld.core.writeoff.MirrorOutcome
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import java.io.IOException

/**
 * Fills the pallet mode's offline caches: the tenant catalogue with its pallet
 * capacities, per-operator permission, the pallet label templates, this
 * device's extension-1 SSCC block, and the shared box registry.
 *
 * The three caches are replaced wholesale, because the server's answer IS the
 * current dictionary -- an archived product must disappear from the device,
 * not linger.
 */
class PalletBootstrapMirror(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val blocks: SsccBlockApplier,
    private val registry: BoxRegistryMirror,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** When the bootstrap last landed, feeding the mode's «данные на 10:42» stamp. */
    val stampAt: Flow<Long?> = db.metaDao().observe(MetaStore.PALLET_BOOTSTRAP_AT).map { it?.toLongOrNull() }

    suspend fun issuerPrefix(): String? = meta.get(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX)

    suspend fun refresh(): MirrorOutcome = try {
        db.recovery.work { refreshOwned() }
    } catch (_: IOException) {
        MirrorOutcome.Offline
    } catch (_: retrofit2.HttpException) {
        MirrorOutcome.Failed("http")
    } catch (_: SerializationException) {
        MirrorOutcome.Failed("shape")
    }

    private suspend fun refreshOwned(): MirrorOutcome {
        val bootstrap = api.palletBootstrap()
        db.recovery.commit {
            db.palletProductDao().replaceAll(
                bootstrap.products.map {
                    PalletProductEntity(it.id, it.gtin14, it.name, it.printName, it.shelfLifeDays, it.palletBoxCapacity, it.chzProductGroupCode)
                },
            )
            db.palletPermissionDao().replaceAll(bootstrap.operators.map { PalletPermissionEntity(it.employeeId, it.canBuildPallets) })
            db.palletLabelTemplateDao().replaceAll(
                listOfNotNull(
                    bootstrap.palletLabelTemplates.organisation?.let { PalletLabelTemplateEntity(PalletLabelTemplateEntity.ORG, it.toString()) },
                ) +
                    bootstrap.palletLabelTemplates.byCategory.map {
                        PalletLabelTemplateEntity(PalletLabelTemplateEntity.category(it.chzProductGroupCode), it.template.toString())
                    },
            )
        }
        // Applied BEFORE the prefix/stamp are remembered: a failed `addRange` must
        // not leave behind a remembered prefix for a block the pool never got.
        blocks.apply(bootstrap.palletSscc, bootstrap.palletSsccRevokedFrom)
        db.recovery.commit {
            // A null block means "no numbers today" (no GLN, read-only, exhausted): the pool keeps what it has
            // and the prefix is forgotten so a close reports NoIssuer rather than burning from a stale one.
            if (bootstrap.palletSscc != null) meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, bootstrap.palletSscc.issuerPrefix)
            else meta.remove(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX)
            meta.put(MetaStore.PALLET_BOOTSTRAP_AT, clock().toString())
        }
        return registry.walk()
    }
}
