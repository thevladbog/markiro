//! HTTPS server: router, TLS accept loop and graceful shutdown.

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use sqlx::SqlitePool;
use time::OffsetDateTime;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::clock::{format_timestamp, Clock};
use crate::error::ApiError;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// How other devices reach this host: what a pairing payload carries.
#[derive(Clone)]
pub struct Endpoint {
    /// SHA-256 of the TLS certificate, lower-case hex.
    pub fingerprint: String,
    pub port: u16,
    /// This host's addresses in the local network, read for every new code.
    pub addresses: Arc<dyn Fn() -> Vec<Ipv4Addr> + Send + Sync>,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub host_id: String,
    pub clock: Arc<dyn Clock>,
    pub login_limiter: Arc<crate::rate_limit::RateLimiter>,
    /// Pairing claims, per address; separate from `login_limiter`, so a
    /// mistyped pairing code never locks the office out on the same computer.
    pub claim_limiter: Arc<crate::rate_limit::RateLimiter>,
    /// License previews and loads, per address (plan ЛЦ-2, spec §8.3: like
    /// the sign-in); its refusals write no row.
    pub license_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub endpoint: Endpoint,
    /// Raised by `commit_with_revision` after each commit that moved the
    /// revision; it starts at 0, so read `db::current_revision` for the
    /// current value.
    pub revisions: Arc<watch::Sender<i64>>,
    /// Becomes `true` once when the host stops; open change streams end.
    pub stopping: Arc<watch::Sender<bool>>,
    /// Counts device revocations; raised after each revoking commit. A change
    /// stream woken by it checks its own device and ends if that was revoked.
    pub revocations: Arc<watch::Sender<u64>>,
    /// How often a change stream writes a comment to keep the connection
    /// alive (15 s; tests shorten it).
    pub stream_heartbeat: Duration,
    /// The copies of the database (plan РК); `None` answers the office's
    /// backup routes `not_found`. `crate::start` always sets it.
    pub backups: Option<Arc<crate::backup::Backups>>,
    /// The site's license (plan ЛЦ-2): its files, its state, the time it
    /// trusts and its gates.
    pub license: Arc<crate::license::LicenseService>,
}

impl AppState {
    pub fn new(pool: SqlitePool, host_id: String, clock: Arc<dyn Clock>) -> Self {
        Self {
            pool,
            host_id,
            login_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            claim_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            license_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                10,
                time::Duration::minutes(1),
                clock.clone(),
            )),
            endpoint: Endpoint {
                fingerprint: String::new(),
                port: markiro_proto::DEFAULT_PORT,
                addresses: Arc::new(crate::network::lan_ipv4_addresses),
            },
            revisions: Arc::new(watch::channel(0).0),
            stopping: Arc::new(watch::channel(false).0),
            revocations: Arc::new(watch::channel(0).0),
            stream_heartbeat: Duration::from_secs(15),
            backups: None,
            license: Arc::new(crate::license::LicenseService::new(
                markiro_proto::trust::license_keyset(),
                Arc::new(crate::license::trial_mark::NoMark),
            )),
            clock,
        }
    }

    pub fn now(&self) -> OffsetDateTime {
        self.clock.now()
    }

    /// `now()` in the stored timestamp format.
    pub fn timestamp(&self) -> String {
        format_timestamp(self.now())
    }

    /// The certificate fingerprint and the port other devices connect to.
    pub fn with_endpoint(mut self, fingerprint: String, port: u16) -> Self {
        self.endpoint.fingerprint = fingerprint;
        self.endpoint.port = port;
        self
    }

    /// Replace the address lookup; tests use fixed addresses.
    pub fn with_addresses(
        mut self,
        addresses: impl Fn() -> Vec<Ipv4Addr> + Send + Sync + 'static,
    ) -> Self {
        self.endpoint.addresses = Arc::new(addresses);
        self
    }

    /// Change-stream heartbeat interval; tests use a short one.
    pub fn with_stream_heartbeat(mut self, heartbeat: Duration) -> Self {
        self.stream_heartbeat = heartbeat;
        self
    }

    /// The copies of the database the office's backup routes read.
    pub fn with_backups(mut self, backups: Arc<crate::backup::Backups>) -> Self {
        self.backups = Some(backups);
        self
    }

    /// Replace the license service (`crate::start` gives it the registry's
    /// mark; tests a mark of their own).
    pub fn with_license(mut self, license: Arc<crate::license::LicenseService>) -> Self {
        self.license = license;
        self
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .merge(protected_routes().route_layer(middleware::from_fn(protocol_guard)))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), restore_hold))
        .with_state(state)
}

/// `Retry-After` of a held answer, in seconds: the hold ends when an
/// administrator decides, which takes minutes, so a station asks about once
/// a minute.
pub const RESTORE_RETRY_AFTER_SECS: u64 = 60;

/// What a restore holds (plan РК): a station's facts, its code checks and
/// its warehouse reprints, whose answers depend on the shifts, blocks and
/// codes a copy may lack.
/// The reads of a station's conflicts (plan КНФ) are not held on purpose: a
/// copy is an older state, so they can only tell of fewer reviews and
/// displacements, never wrong ones.
fn held_by_a_restore(path: &str) -> bool {
    path == "/v1/device/facts"
        || path.starts_with("/v1/device/codes/")
        // A reprint looks up and records against shifts, boxes and codes a
        // copy may lack (plan СКЛ).
        || path.starts_with("/v1/device/warehouse/")
}

/// From `markiro-host restore` until an administrator resumes, a held path
/// answers `restore_pending` (503) instead of a receipt: a receipt is kept
/// for good, so a fact refused against a copy that lacks its shift or block
/// would stay refused, while a station sends a fact the host did not take
/// again later. A layer over the whole router, so a held path is held
/// whichever plan adds its route.
pub async fn restore_hold(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if held_by_a_restore(request.uri().path()) {
        let since: Option<String> =
            sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id = 1")
                .fetch_one(&state.pool)
                .await
                .map_err(ApiError::internal)?;
        if let Some(since) = since {
            let mut held = ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                markiro_proto::codes::RESTORE_PENDING,
                "the host was restored from a copy: facts wait until the office resumes them",
            )
            .with_details(serde_json::json!({ "since": since }))
            .into_response();
            held.headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from(RESTORE_RETRY_AFTER_SECS));
            return Ok(held);
        }
    }
    Ok(next.run(request).await)
}

/// Routes behind the protocol guard.
fn protected_routes() -> Router<AppState> {
    Router::new()
        .route("/v1/local-pair", post(crate::routes::pairing::local_pair))
        .route("/v1/device", get(crate::routes::devices::device_info))
        .route("/v1/device/line", put(crate::routes::devices::select_line))
        .route(
            "/v1/device/shifts",
            get(crate::routes::device_shifts::list_device_shifts)
                .post(crate::routes::device_shifts::create_device_shift),
        )
        .route(
            "/v1/device/shifts/{id}/enter",
            post(crate::routes::device_shifts::enter_shift),
        )
        .route(
            "/v1/device/sscc/blocks",
            post(crate::routes::sscc_blocks::issue_block),
        )
        .route(
            "/v1/device/sscc/blocks/known",
            post(crate::routes::known_blocks::register_known_blocks),
        )
        .route(
            "/v1/device/facts",
            post(crate::routes::facts::receive_facts),
        )
        .route(
            "/v1/device/codes/{code_hash}",
            get(crate::routes::codes::check_code),
        )
        .route(
            "/v1/device/conflicts/status",
            post(crate::routes::device_conflicts::conflict_status),
        )
        .route(
            "/v1/device/displacements",
            get(crate::routes::device_conflicts::list_displacements),
        )
        .route(
            "/v1/device/warehouse/lookup",
            post(crate::routes::warehouse::lookup),
        )
        .route(
            "/v1/device/warehouse/reprints",
            post(crate::routes::warehouse::receive_records),
        )
        .route("/v1/changes", get(crate::routes::changes::changes))
        .route("/v1/changes/stream", get(crate::routes::changes::stream))
        .route(
            "/v1/office/devices",
            get(crate::routes::devices::list_devices),
        )
        .route(
            "/v1/office/devices/{id}",
            put(crate::routes::devices::update_device),
        )
        .route(
            "/v1/office/devices/{id}/revoke",
            post(crate::routes::devices::revoke_device),
        )
        .route("/v1/office/login", post(crate::routes::office_auth::login))
        .route(
            "/v1/office/logout",
            post(crate::routes::office_auth::logout),
        )
        .route("/v1/office/me", get(crate::routes::office_auth::me))
        .route(
            "/v1/office/me/password",
            put(crate::routes::office_auth::change_password),
        )
        .route("/v1/bootstrap", post(crate::routes::bootstrap::bootstrap))
        .route(
            "/v1/office/org",
            get(crate::routes::org::get_org).put(crate::routes::org::put_org),
        )
        .route(
            "/v1/office/org/logo",
            get(crate::routes::org_logo::get_logo)
                .put(crate::routes::org_logo::put_logo)
                .delete(crate::routes::org_logo::delete_logo),
        )
        .route("/v1/office/sscc", get(crate::routes::sscc::get_sscc))
        .route(
            "/v1/office/sscc/counters/{prefix}/{extension}",
            put(crate::routes::sscc::put_counter),
        )
        .route(
            "/v1/office/sscc/block-sizes",
            put(crate::routes::sscc::put_block_sizes),
        )
        .route(
            "/v1/office/counterparties",
            get(crate::routes::counterparties::list_counterparties)
                .post(crate::routes::counterparties::create_counterparty),
        )
        .route(
            "/v1/office/counterparties/{id}",
            put(crate::routes::counterparties::update_counterparty),
        )
        .route(
            "/v1/office/disaggregation-reasons",
            get(crate::routes::disaggregation_reasons::list_reasons)
                .post(crate::routes::disaggregation_reasons::create_reason),
        )
        .route(
            "/v1/office/disaggregation-reasons/{id}",
            put(crate::routes::disaggregation_reasons::update_reason),
        )
        .route(
            "/v1/office/disaggregation",
            get(crate::routes::disaggregation::list_documents)
                .post(crate::routes::disaggregation::create_document),
        )
        .route(
            "/v1/office/disaggregation/{id}",
            get(crate::routes::disaggregation::get_document)
                .put(crate::routes::disaggregation::update_document),
        )
        .route(
            "/v1/office/disaggregation/{id}/lines",
            post(crate::routes::disaggregation::add_lines),
        )
        .route(
            "/v1/office/disaggregation/{id}/lines/{line_id}",
            delete(crate::routes::disaggregation::delete_line),
        )
        .route(
            "/v1/office/disaggregation/{id}/apply",
            post(crate::routes::disaggregation::apply_document),
        )
        .route(
            "/v1/office/disaggregation/{id}/cancel",
            post(crate::routes::disaggregation::cancel_document),
        )
        .route(
            "/v1/office/disaggregation/{id}/report-data",
            get(crate::routes::office_disaggregation_reports::report_data),
        )
        .route(
            "/v1/office/disaggregation/{id}/exports",
            post(crate::routes::office_disaggregation_reports::record_export),
        )
        .route(
            "/v1/office/lines",
            get(crate::routes::lines::list_lines).post(crate::routes::lines::create_line),
        )
        .route(
            "/v1/office/lines/{id}",
            put(crate::routes::lines::update_line),
        )
        .route(
            "/v1/office/employees",
            get(crate::routes::employees::list_employees)
                .post(crate::routes::employees::create_employee),
        )
        .route(
            "/v1/office/employees/{id}",
            put(crate::routes::employees::update_employee),
        )
        .route(
            "/v1/office/operators",
            get(crate::routes::operators::list_operators)
                .post(crate::routes::operators::create_operator),
        )
        .route(
            "/v1/office/operators/{id}",
            put(crate::routes::operators::update_operator),
        )
        .route(
            "/v1/office/operators/{id}/badges",
            post(crate::routes::operators::create_badge),
        )
        .route(
            "/v1/office/operators/{id}/badges/{badge_id}",
            delete(crate::routes::operators::revoke_badge),
        )
        .route(
            "/v1/office/badge-salt",
            get(crate::routes::operators::badge_salt),
        )
        .route(
            "/v1/office/product-groups",
            get(crate::routes::products::list_product_groups),
        )
        .route(
            "/v1/office/products",
            get(crate::routes::products::list_products)
                .post(crate::routes::products::create_product),
        )
        .route(
            "/v1/office/products/{id}",
            put(crate::routes::products::update_product),
        )
        .route(
            "/v1/office/products/{id}/photo",
            get(crate::routes::product_photos::get_photo)
                .put(crate::routes::product_photos::put_photo)
                .delete(crate::routes::product_photos::delete_photo),
        )
        .route(
            "/v1/office/templates",
            get(crate::routes::templates::list_templates)
                .post(crate::routes::templates::create_template),
        )
        .route(
            "/v1/office/templates/{id}",
            get(crate::routes::templates::get_template)
                .put(crate::routes::templates::update_template)
                .delete(crate::routes::templates::delete_template),
        )
        .route(
            "/v1/office/template-defaults",
            get(crate::routes::template_defaults::get_template_defaults)
                .put(crate::routes::template_defaults::put_template_defaults),
        )
        .route(
            "/v1/office/pallet-sheets",
            get(crate::routes::pallet_sheets::list_sheets)
                .post(crate::routes::pallet_sheets::create_sheet),
        )
        .route(
            "/v1/office/pallet-sheets/{id}",
            put(crate::routes::pallet_sheets::update_sheet)
                .delete(crate::routes::pallet_sheets::delete_sheet),
        )
        .route(
            "/v1/office/pallet-sheet-default",
            put(crate::routes::pallet_sheets::put_default),
        )
        .route(
            "/v1/office/shifts",
            get(crate::routes::office_shifts::list_shifts)
                .post(crate::routes::office_shifts::create_shift),
        )
        .route(
            "/v1/office/shifts/{id}",
            get(crate::routes::office_shifts::get_shift)
                .put(crate::routes::office_shifts::update_shift)
                .delete(crate::routes::office_shifts::delete_shift),
        )
        .route(
            "/v1/office/shifts/{id}/close",
            post(crate::routes::office_shifts::close_shift),
        )
        .route(
            "/v1/office/shifts/{id}/boxes",
            get(crate::routes::office_boxes::list_boxes),
        )
        .route(
            "/v1/office/shifts/{id}/pallets",
            get(crate::routes::office_boxes::list_pallets),
        )
        .route(
            "/v1/office/shifts/{id}/exceptions",
            get(crate::routes::office_shift_review::list_exceptions),
        )
        .route(
            "/v1/office/shifts/{id}/rejections",
            get(crate::routes::office_shift_review::list_rejections),
        )
        .route(
            "/v1/office/conflicts",
            get(crate::routes::office_conflicts::list_conflicts),
        )
        .route(
            "/v1/office/conflicts/{id}/review",
            post(crate::routes::office_conflicts::review_conflict),
        )
        .route(
            "/v1/office/shifts/{id}/export-source",
            get(crate::routes::office_exports::export_source),
        )
        .route(
            "/v1/office/shifts/{id}/exports",
            get(crate::routes::office_exports::list_exports)
                .post(crate::routes::office_exports::record_export),
        )
        .route(
            "/v1/office/export-files",
            get(crate::routes::office_export_files::list)
                .post(crate::routes::office_export_files::begin),
        )
        .route(
            "/v1/office/export-files/settings",
            get(crate::routes::office_export_files::get_settings)
                .put(crate::routes::office_export_files::put_settings),
        )
        .route(
            "/v1/office/export-files/{id}/chunks/{seq}",
            get(crate::routes::office_export_files::get_chunk)
                .put(crate::routes::office_export_files::put_chunk),
        )
        .route(
            "/v1/office/export-files/{id}/complete",
            post(crate::routes::office_export_files::complete),
        )
        .route(
            "/v1/office/export-files/{id}/download",
            post(crate::routes::office_export_files::open_download),
        )
        .route(
            "/v1/office/shifts/{id}/pallet-report-data",
            get(crate::routes::office_reports::pallet_report),
        )
        .route(
            "/v1/office/boxes/{id}/report-data",
            get(crate::routes::office_reports::box_report),
        )
        .route(
            "/v1/office/boxes/{id}",
            get(crate::routes::office_cards::box_card),
        )
        .route(
            "/v1/office/pallets",
            get(crate::routes::office_pallets::list_pallets),
        )
        .route(
            "/v1/office/pallets/{id}",
            get(crate::routes::office_cards::pallet_card),
        )
        .route(
            "/v1/office/codes",
            get(crate::routes::office_codes::search_codes),
        )
        .route(
            "/v1/office/codes/{code_hash}",
            get(crate::routes::office_codes::code_card),
        )
        .route(
            "/v1/office/backups",
            get(crate::routes::backups::get_backups).post(crate::routes::backups::start_backup),
        )
        .route(
            "/v1/office/backups/settings",
            put(crate::routes::backups::put_settings),
        )
        .route(
            "/v1/office/backups/resume",
            post(crate::routes::backups::resume_facts),
        )
        .route(
            "/v1/office/updates/started",
            post(crate::routes::app_updates::record_started),
        )
        .route(
            "/v1/office/import",
            post(crate::routes::cloud_import::import).layer(axum::extract::DefaultBodyLimit::max(
                crate::routes::cloud_import::MAX_BODY_BYTES,
            )),
        )
        .route(
            "/v1/office/users",
            get(crate::routes::office_users::list_users)
                .post(crate::routes::office_users::create_user),
        )
        .route(
            "/v1/office/users/{id}",
            put(crate::routes::office_users::update_user),
        )
        .route(
            "/v1/office/users/{id}/password",
            put(crate::routes::office_users::set_password),
        )
        .route(
            "/v1/office/pairing-codes",
            post(crate::routes::pairing::create_code),
        )
        .route("/v1/pairing/claim", post(crate::routes::pairing::claim))
        .route(
            "/v1/office/license",
            get(crate::license::routes::get_license)
                .put(crate::license::routes::load_license)
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::license::routes::MAX_BODY_BYTES,
                )),
        )
        .route(
            "/v1/office/license/preview",
            post(crate::license::routes::preview_license).layer(
                axum::extract::DefaultBodyLimit::max(crate::license::routes::MAX_BODY_BYTES),
            ),
        )
        .route(
            "/v1/office/license/activation-request",
            get(crate::license::routes::activation_request),
        )
        .route(
            "/v1/office/license/emergency",
            post(crate::license::routes::enable_emergency),
        )
}

/// The protocol version the client sent, set by [`protocol_guard`] for every
/// route behind it: handlers that record it read this instead of parsing the
/// header again.
#[derive(Debug, Clone, Copy)]
pub struct ClientProtocol(pub u32);

/// Every route except `hello` requires a supported protocol version
/// (spec §4.5). Apply with `route_layer` on the protected routes only, so
/// `hello` answers any version and unknown paths stay `not_found`.
pub async fn protocol_guard(mut request: Request, next: Next) -> Result<Response, ApiError> {
    let version = request
        .headers()
        .get(markiro_proto::PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok());
    match version {
        Some(version)
            if (markiro_proto::MIN_PROTOCOL_VERSION..=markiro_proto::PROTOCOL_VERSION)
                .contains(&version) =>
        {
            request.extensions_mut().insert(ClientProtocol(version));
            Ok(next.run(request).await)
        }
        other => Err(ApiError::protocol_unsupported(other)),
    }
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let (initialized, restore_epoch): (bool, Option<String>) =
        sqlx::query_as("SELECT initialized_at IS NOT NULL, restore_epoch FROM site WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
        min_protocol: markiro_proto::MIN_PROTOCOL_VERSION,
        host_id: state.host_id.clone(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: state.timestamp(),
        initialized,
        restore_epoch,
    }))
}

async fn method_not_allowed(method: Method, uri: Uri) -> ApiError {
    ApiError::method_not_allowed(format!("{method} is not allowed on {}", uri.path()))
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

/// Connections whose TLS handshake already completed. Handshakes run in their
/// own tasks, so one slow client cannot stall accepting the next.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    bound: SocketAddr,
}

impl TlsListener {
    pub async fn bind(addr: SocketAddr, tls: Arc<rustls::ServerConfig>) -> std::io::Result<Self> {
        let tcp = TcpListener::bind(addr).await.map_err(|error| {
            std::io::Error::new(error.kind(), format!("cannot listen on {addr}: {error}"))
        })?;
        let bound = tcp.local_addr()?;
        let (sender, connections) = mpsc::channel(64);
        let acceptor = TlsAcceptor::from(tls);
        tokio::spawn(async move {
            loop {
                // Stop accepting (and release the port) as soon as the
                // listener is dropped, without waiting for another client.
                let accepted = tokio::select! {
                    _ = sender.closed() => break,
                    accepted = tcp.accept() => accepted,
                };
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, "accepting a TCP connection failed");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        Ok(Ok(tls_stream)) => {
                            let _ = sender.send((tls_stream, peer)).await;
                        }
                        Ok(Err(error)) => tracing::debug!(%peer, %error, "TLS handshake failed"),
                        Err(_) => tracing::debug!(%peer, "TLS handshake timed out"),
                    }
                });
            }
        });
        Ok(Self { connections, bound })
    }

    /// The address actually bound (useful after binding port 0).
    pub fn bound_addr(&self) -> SocketAddr {
        self.bound
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.connections.recv().await {
            Some(connection) => connection,
            // The accept task outlives this listener, so this never happens.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.bound)
    }
}

/// Serve until `shutdown` resolves; open connections finish first.
///
/// `into_make_service_with_connect_info::<SocketAddr>()` needs
/// `SocketAddr: Connected<IncomingStream<'_, TlsListener>>`, but axum only
/// ships that impl for its own `TcpListener`; implementing the foreign
/// `Connected` trait for the foreign `SocketAddr` here would violate the
/// orphan rules even though the listener type is local (`IncomingStream`'s
/// outer type is still foreign). Wrapping with the built-in `tap_io` no-op
/// instead produces `TapIo<TlsListener, _>`, for which axum already provides
/// a blanket `Connected` impl over any `Listener`, so no new trait impl or
/// public type is needed.
pub async fn serve(
    listener: TlsListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    use axum::serve::ListenerExt;

    let listener = listener.tap_io(|_io| {});
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::{middleware, Router};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    async fn call(header: Option<&str>) -> (StatusCode, Value) {
        let app = Router::new()
            .route("/probe", get(|| async { "ok" }))
            .route_layer(middleware::from_fn(super::protocol_guard));
        let mut builder = Request::get("/probe");
        if let Some(value) = header {
            builder = builder.header(markiro_proto::PROTOCOL_HEADER, value);
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn a_supported_version_passes() {
        // Protocol 5 (the duplicate print, plan РЕЖ part B) is this build's;
        // 4 (shift modes, part A), 3 (pallets, plan ПЛ-Х), 2 (stage 2a) and 1
        // (stage 1) are still taken.
        assert_eq!(call(Some("5")).await.0, StatusCode::OK);
        assert_eq!(call(Some("4")).await.0, StatusCode::OK);
        assert_eq!(call(Some("3")).await.0, StatusCode::OK);
        assert_eq!(call(Some("2")).await.0, StatusCode::OK);
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_missing_header_is_refused_with_details() {
        let (status, body) = call(None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "protocol_unsupported");
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 5);
    }

    #[tokio::test]
    async fn an_out_of_range_or_garbled_version_is_refused() {
        let (status, body) = call(Some("7")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["details"]["protocol"], 7);
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("6")).await.0, StatusCode::BAD_REQUEST);
    }
}
