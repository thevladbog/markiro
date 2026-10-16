//! An office user's photo (plan АВА). Routes, all behind an office session:
//!
//! - `GET /v1/office/users/{id}/avatar`: the photo as JSON (`{ "avatar": … }`,
//!   the picture as base64 like a product's photo, since the shell passes
//!   JSON only), or `null`; every role, any user.
//! - `GET /v1/office/users/{id}/avatar/image`: the same bytes raw, with the
//!   true `Content-Type`, `X-Content-Type-Options: nosniff`, the checksum as
//!   a strong `ETag` and `If-None-Match` answered `304`; `404
//!   avatar_not_found` without a photo.
//! - `PUT …/avatar` (`{ "dataBase64" }`): the owner only. Another user's id,
//!   an administrator's included, is `403 forbidden_replace_other` before the
//!   body is read for anything but its shape, and a user who does not exist
//!   is refused the same way, so the answer says nothing about who exists.
//! - `DELETE …/avatar`: the owner, or an administrator for someone else's.
//!
//! The host keeps one row per user in `user_avatars` (migration `0046`),
//! reads the type and the sides from the picture's header and decodes
//! nothing (`avatar.rs`), builds no path from anything (the picture is a
//! BLOB, the id a bound parameter), and answers every refusal with a code of
//! its own. The same picture sent again writes nothing and no audit row; a
//! clearing of none writes nothing. A change takes no host revision: a photo
//! is no feed item, so the stations hear nothing of it. The audit rows name
//! the size and the type, never the picture.
//!
//! The version (`avatarVersion` of the user and the session) is the host's
//! time of the change in milliseconds, raised above the row's previous one
//! when the clock stood or went back. It is also what a client keys its
//! cache by; the raw route's `ETag` is the checksum and does not depend on it.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequest, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{codes, UserAvatar, UserAvatarPut, UserAvatarState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::avatar;
use crate::backup::identity::sha256_hex;
use crate::db::begin_write;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

/// The stored photo with its bytes.
struct Stored {
    media_type: String,
    width: u32,
    height: u32,
    data: Vec<u8>,
    checksum: String,
    version: i64,
    updated_at: String,
}

impl Stored {
    fn wire(self) -> UserAvatar {
        use base64::{engine::general_purpose::STANDARD, Engine};
        UserAvatar {
            width: self.width,
            height: self.height,
            data_base64: STANDARD.encode(self.data),
            media_type: self.media_type,
            checksum: self.checksum,
            version: self.version,
            updated_at: self.updated_at,
        }
    }
}

/// `media_type, width, height, data, checksum, version, updated_at`.
type StoredRow = (String, u32, u32, Vec<u8>, String, i64, String);

async fn read_stored(conn: &mut SqliteConnection, id: &str) -> Result<Option<Stored>, ApiError> {
    let row: Option<StoredRow> = sqlx::query_as(
        "SELECT media_type, width, height, data, checksum, version, updated_at \
         FROM user_avatars WHERE user_id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.map(
        |(media_type, width, height, data, checksum, version, updated_at)| Stored {
            media_type,
            width,
            height,
            data,
            checksum,
            version,
            updated_at,
        },
    ))
}

/// `not_found` unless `id` names an office user, an inactive one included
/// (a person who left keeps the photo their history shows).
async fn check_user(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM office_users WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("no such office user"))
}

pub async fn get_avatar(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<UserAvatarState>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    check_user(&mut conn, &id).await?;
    Ok(Json(UserAvatarState {
        avatar: read_stored(&mut conn, &id).await?.map(Stored::wire),
    }))
}

/// Whether an `If-None-Match` header names `etag` (strong comparison is not
/// required for `GET`: a weak spelling of the same value matches too), or `*`.
fn none_match(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|candidate| {
            candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
        })
}

pub async fn get_image(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    check_user(&mut conn, &id).await?;
    let stored = read_stored(&mut conn, &id).await?.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            codes::AVATAR_NOT_FOUND,
            "this user has no photo",
        )
    })?;
    let etag = format!("\"{}\"", stored.checksum);
    let validator = HeaderValue::from_str(&etag).map_err(ApiError::internal)?;
    // The picture is private to the office session that asks, and every use of
    // it asks again: the answer is `304` while the checksum holds.
    let mut answer = if none_match(&headers, &etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let media_type = HeaderValue::from_str(&stored.media_type).map_err(ApiError::internal)?;
        let mut response = (StatusCode::OK, stored.data).into_response();
        let head = response.headers_mut();
        head.insert(header::CONTENT_TYPE, media_type);
        head.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("inline"),
        );
        response
    };
    let head = answer.headers_mut();
    head.insert(header::ETAG, validator);
    head.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    head.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(answer)
}

/// `ApiJson<UserAvatarPut>` whose body-limit rejection is `avatar_too_large`
/// (a body past [`avatar::MAX_BODY_BYTES`] is a picture past 2 MiB, whatever
/// it claims to be) instead of a malformed request.
pub struct AvatarBody(UserAvatarPut);

impl FromRequest<AppState> for AvatarBody {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        match Json::<UserAvatarPut>::from_request(request, state).await {
            Ok(Json(put)) => Ok(Self(put)),
            Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
                Err(avatar::too_large())
            }
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

fn forbidden_replace_other() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        codes::FORBIDDEN_REPLACE_OTHER,
        "only the owner of a profile sets its photo",
    )
}

pub async fn put_avatar(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    AvatarBody(put): AvatarBody,
) -> Result<Json<UserAvatarState>, ApiError> {
    if id != context.user.id {
        return Err(forbidden_replace_other());
    }
    // Each attempt counts, a refused one too: an upload is megabytes of work.
    state.avatar_limiter.check(peer.ip())?;
    let (bytes, picture) = avatar::from_base64(&put.data_base64)?;
    let checksum = sha256_hex(&bytes);
    let at = state.now();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let previous = read_stored(&mut tx, &id).await?;
    // The same picture again changes nothing: no write, no audit row; the
    // answer is the stored photo, its version included.
    if previous
        .as_ref()
        .is_some_and(|stored| stored.checksum == checksum)
    {
        return Ok(Json(UserAvatarState {
            avatar: previous.map(Stored::wire),
        }));
    }
    let millis =
        i64::try_from(at.unix_timestamp_nanos() / 1_000_000).map_err(ApiError::internal)?;
    let version = previous
        .as_ref()
        .map_or(millis, |stored| millis.max(stored.version + 1))
        .max(1);
    let stamp = crate::clock::format_timestamp(at);
    sqlx::query(
        "INSERT INTO user_avatars \
         (user_id, media_type, width, height, data, checksum, version, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET \
         media_type = excluded.media_type, width = excluded.width, height = excluded.height, \
         data = excluded.data, checksum = excluded.checksum, version = excluded.version, \
         updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(picture.media_type)
    .bind(picture.width)
    .bind(picture.height)
    .bind(&bytes)
    .bind(&checksum)
    .bind(version)
    .bind(&stamp)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &stamp,
        Entry {
            actor: context.actor(),
            action: actions::OFFICE_USER_AVATAR_SET,
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "width": picture.width,
                "height": picture.height,
                "bytes": bytes.len(),
                "mediaType": picture.media_type,
                "replaced": previous.is_some(),
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let answer = UserAvatarState {
        avatar: read_stored(&mut tx, &id).await?.map(Stored::wire),
    };
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}

/// Clears the photo; clearing none writes nothing and answers the same.
pub async fn delete_avatar(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<UserAvatarState>, ApiError> {
    let own = id == context.user.id;
    if !own {
        context.require_admin()?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if own {
        context.require_session_in(&mut tx).await?;
    } else {
        context.require_admin_in(&mut tx).await?;
        check_user(&mut tx, &id).await?;
    }
    let removed = sqlx::query("DELETE FROM user_avatars WHERE user_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if removed > 0 {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::OFFICE_USER_AVATAR_CLEAR,
                target_type: Some("office_user"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details: json!({}),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(UserAvatarState { avatar: None }))
}
