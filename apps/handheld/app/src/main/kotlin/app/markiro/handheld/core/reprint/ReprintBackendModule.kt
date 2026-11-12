package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.host.HostOrgPrint
import app.markiro.handheld.core.host.HostReferenceSync
import app.markiro.handheld.core.host.HostRevocation
import app.markiro.handheld.core.label.OrganizationPrintBranding
import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.storage.*
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import javax.inject.Singleton

/** Uses the generation-tagged authenticated cloud Call.Factory, including revocation and backend guards. */
interface ReprintCloudApi {
    @GET("station/warehouse-reprint/{path}") suspend fun get(@Path("path") path: String): JsonObject
    @POST("station/warehouse-reprint/{path}") suspend fun post(@Path("path") path: String, @Body body: RequestBody): JsonObject
}

@Module
@InstallIn(SingletonComponent::class)
object ReprintBackendModule {
    @Provides @Singleton
    fun backend(db: HandheldDatabase, calls: Call.Factory, revocation: HostRevocation, branding: OrganizationPrintBranding): SiteReprintBackend {
        val json = Json { ignoreUnknownKeys = true }
        val cloudApi = Retrofit.Builder().baseUrl("http://placeholder.invalid/").callFactory(calls)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType())).build().create(ReprintCloudApi::class.java)
        val cloud = CloudSiteReprintBackend(cloudApi::get, { path, body -> cloudApi.post(path, body.toRequestBody("application/json".toMediaType())) }, {
            try { branding.refresh() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* Cached logo remains available to rendering. */ }
        })
        fun hostApi(): HostApi {
            val token = checkNotNull(DeviceRecovery.generationContext.get())
            val owner = token.owner
            val epoch = db.recovery.processDatasetEpoch()
            val client = HostHttpClient.pinned(checkNotNull(owner.pinSha256), datasetEpoch = { epoch }) { db.recovery.key(token) }
            return HostApi(OkHttpHostTransport(client, { owner.serverOrigin }))
        }
        val hostCalls = HostCalls(revocation::current) { revocation.reject(it) }
        val host = HostSiteReprintBackend(
            call = { path, body -> hostCalls.run { if (path == "lookup") hostApi().warehouseLookup(body) else hostApi().warehouseReprints(body) } },
            catalog = {
                val api = hostApi()
                // Older app versions consumed this feed without retaining unit templates.
                // Replay once from zero rather than fabricate revisions from the current shift.
                if (db.metaDao().get("host_reprint_catalog_initialized") == null) db.recovery.commit {
                    db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(hostRev = 0)) }
                }
                hostCalls.run { HostReferenceSync(db, db.deviceConfigDao(), MetaStore(db), api).sync() }
                MetaStore(db).put("host_reprint_catalog_initialized", "1")
                db.metaDao().withPrefix("host_reprint_template:").mapNotNull { entry ->
                    val value = reprintObject(entry.value)
                    val kind = when (value.optionalString("purpose")) { "product_duplicate" -> "unit"; "box" -> "box"; "pallet" -> "pallet"; else -> return@mapNotNull null }
                    if (value["enabled"] != JsonPrimitive(true)) return@mapNotNull null
                    val spec = value["spec"] ?: return@mapNotNull null
                    SiteReprintTemplate(
                        "host:" + entry.key.removePrefix("host_reprint_template:"), value.string("name"), kind,
                        spec.toString(), value.toString(),
                        value["rev"]?.jsonPrimitive?.content ?: value["revision"]?.jsonPrimitive?.content ?: "0",
                        reprintDigest(value), (value["chzProductGroupCodes"] as? JsonArray)?.map { it.jsonPrimitive.int },
                        lotNumberSourceId = value.optionalString("lotNumberSourceId")?.let { "host:$it" },
                    )
                }
            },
            branding = { HostOrgPrint(hostApi(), MetaStore(db)).fetch(); Unit },
        )
        return object : SiteReprintBackend {
            private suspend fun selected(): SiteReprintBackend = when (db.deviceConfigDao().get()?.backend) { "host" -> host; "cloud" -> cloud; else -> throw RecoveryBlocked() }
            override suspend fun lookup(raw: String, operatorId: String): SiteReprintLookup = db.recovery.work {
                val backend = selected()
                val result = backend.lookup(raw, operatorId)
                if (backend !== host || result !is SiteReprintLookup.Found) return@work result
                val source = result.source
                val purpose = if (source.kind == "unit") "product_duplicate" else source.kind
                val preferred = source.productId?.let { db.metaDao().get("host_reprint_product_default:$it:${source.kind}") }
                    ?: source.groupCode?.let { db.metaDao().get("host_cat_default:$it:$purpose") }
                    ?: db.metaDao().get("host_reprint_org_default:${source.kind}")
                SiteReprintLookup.Found(source.copy(defaultTemplateId = preferred?.let { "host:$it" }))
            }
            override suspend fun refreshTemplates(): List<SiteReprintTemplate> = db.recovery.work { selected().refreshTemplates() }
            override fun auditPayload(source: SiteReprintSource, input: SiteReprintAuditInput): String {
                // Host snapshots name subjectId/product; cloud keeps its original lookup envelope.
                return if (reprintObject(source.sourceJson).containsKey("subjectId")) host.auditPayload(source, input) else cloud.auditPayload(source, input)
            }
            override suspend fun report(payload: String): SiteReprintReceipt = db.recovery.work {
                val backend = selected()
                val expected = if (backend === host) "host" else "cloud"
                require(reprintObject(payload).string("backend") == expected)
                backend.report(payload)
            }
        }
    }
}
