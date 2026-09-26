//! Error responses: an HTTP status plus the protocol's `ErrorBody`, and the
//! extractors whose rejections must use that body too.

use axum::extract::{FromRequest, FromRequestParts, Path, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{codes, ErrorBody, MIN_PROTOCOL_VERSION, PROTOCOL_HEADER, PROTOCOL_VERSION};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody::new(code, message),
        }
    }

    /// Attach structured detail. Only a JSON object is kept: the protocol's
    /// `details` is always an object.
    pub fn with_details(mut self, details: Value) -> Self {
        if let Value::Object(map) = details {
            self.body.error.details = Some(map);
        }
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &str {
        &self.body.error.code
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, codes::NOT_FOUND, message)
    }

    pub fn method_not_allowed(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            codes::METHOD_NOT_ALLOWED,
            message,
        )
    }

    /// `received` is the version the client sent, if any could be read.
    pub fn protocol_unsupported(received: Option<u32>) -> Self {
        let message = match received {
            Some(version) => {
                format!("protocol {version} is outside {MIN_PROTOCOL_VERSION}..={PROTOCOL_VERSION}")
            }
            None => format!("header {PROTOCOL_HEADER} with a protocol version is required"),
        };
        Self::new(
            StatusCode::BAD_REQUEST,
            codes::PROTOCOL_UNSUPPORTED,
            message,
        )
        .with_details(json!({
            "protocol": received,
            "minProtocol": MIN_PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
        }))
    }

    /// A field-level input error; `field` uses the request's JSON path
    /// (`org.gln`, `admin.password`).
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
            .with_details(json!({ "field": field }))
    }

    /// A request that could not be read at all (bad JSON, wrong types, unknown fields).
    pub fn malformed(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::VALIDATION_FAILED, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, codes::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, codes::FORBIDDEN, message)
    }

    /// A uniqueness conflict; `constraint` names it (`login`, `gtin`, …).
    pub fn conflict(constraint: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, codes::CONFLICT, message)
            .with_details(json!({ "constraint": constraint }))
    }

    /// The row changed since the client read it.
    pub fn stale_revision(current_rev: i64) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            codes::STALE_REVISION,
            "the record changed since it was read",
        )
        .with_details(json!({ "currentRev": current_rev }))
    }

    /// Logs the cause on the host; the client only learns that it failed.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::INTERNAL,
            "internal error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// `Json<T>` whose rejections become `validation_failed`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}

/// `Path<T>` whose rejections become `validation_failed`.
pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::malformed(rejection.body_text())),
        }
    }
}
