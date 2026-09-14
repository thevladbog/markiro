package app.markiro.handheld.core.network

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/** Station-only endpoints; the handheld authenticates exactly like a station (`x-api-key`). */
interface StationApi {
    @POST("station/grants/v1/configuration")
    suspend fun grantConfiguration(@Body body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject

    @GET("station/grants/v1/keyset")
    suspend fun grantKeyset(): kotlinx.serialization.json.JsonObject

    @POST("station/grants/v1/device")
    suspend fun deviceGrant(@Body body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject

    @POST("station/grants/v1/tasks")
    suspend fun taskGrant(@Body body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject

    @POST("station/grants/v1/readiness")
    suspend fun grantReadiness(@Body body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject

    @GET("station/identity")
    suspend fun identity(): IdentityResponse

    @GET("station/operators")
    suspend fun operators(): RosterResponse

    /** Without `lineId` the server scopes a device to its own line plus unassigned shifts. */
    @GET("shifts")
    suspend fun shifts(@Query("status") status: String? = null, @Query("lineId") lineId: String? = null): ShiftListResponse

    /** `scope=all` (handheld only) lists every running inventory, not just the device line. */
    @GET("station/inventory-tasks")
    suspend fun inventoryTasks(@Query("scope") scope: String? = null): InventoryTaskListResponse

    @POST("station/inventory-tasks/resolve-barcode")
    suspend fun resolveInventoryBarcode(@Body body: ResolveTaskRequest): ResolveTaskResponse

    @POST("station/inventories/{id}/join")
    suspend fun joinInventory(@Path("id") id: String, @Body body: JoinInventoryRequest): InventoryManifestDto

    @GET("station/inventories/{id}/bundle/manifest")
    suspend fun inventoryManifest(@Path("id") id: String): InventoryManifestDto

    @GET("station/inventories/{id}/bundle/codes")
    suspend fun inventoryCodes(@Path("id") id: String, @Query("cursor") cursor: String?, @Query("limit") limit: Int): InventoryBundlePageDto

    @POST("station/inventories/{id}/leave")
    suspend fun leaveInventory(@Path("id") id: String, @Body body: LeaveInventoryRequest): LeaveInventoryResponse

    @POST("station/grants/v1/evidence/inventories/{id}/leave")
    suspend fun grantInventoryLeave(@Path("id") id: String, @Body body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject

    @POST("shifts/{id}/enter")
    suspend fun enter(@Path("id") id: String): ShiftDto

    @GET("shifts/{id}/bundle")
    suspend fun bundle(@Path("id") id: String): ShiftBundleDto

    @GET("shifts/{id}/code-history")
    suspend fun codeHistory(@Path("id") id: String, @Query("cursor") cursor: String? = null,
        @Query("snapshot") snapshot: String? = null, @Query("limit") limit: Int = 1000): ValidationHistoryPage

    @GET("shifts/{id}/summary")
    suspend fun summary(@Path("id") id: String): ShiftSummaryDto

    @GET("lines")
    suspend fun lines(): LineListResponse

    /** Reasons, the tenant catalog and per-operator permission for the offline write-off mode. */
    @GET("station/writeoff-bootstrap")
    suspend fun writeoffBootstrap(): WriteoffBootstrapDto

    /**
     * Incremental box registry. `until` is null on the first page of a walk and
     * echoed from the first page afterwards; the server rejects it on page one.
     * `POST /station/writeoffs` is not here: it goes through [SyncTransport] as
     * frozen bytes so a retry is byte-identical.
     */
    @GET("station/box-registry")
    suspend fun boxRegistry(
        @Query("since") since: String?,
        @Query("until") until: String?,
        @Query("cursor") cursor: String?,
        @Query("limit") limit: Int,
    ): BoxRegistryPageDto
}
