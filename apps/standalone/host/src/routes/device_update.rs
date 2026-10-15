//! The update routes of devices (plan ОБН-3, spec §10.11.3), outside
//! `protocol_guard`: a device of any protocol version — one the host
//! already refuses as `app_too_old` included — learns of its update and
//! gets it, but only with a live device key (`AuthDevice`); an office
//! session alone opens neither, and the device key opens no office upload.
//! Their answers are frozen like `hello`'s: new fields only additive.
//! `AuthDevice` records the device's version too (plan ОБН-1), so every
//! read keeps «Устройства и версии» current.

use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{DeviceUpdateOffer, OfferedPackage, PackageState};

use crate::auth::AuthDevice;
use crate::error::ApiError;
use crate::server::AppState;

/// `GET /v1/device/update`: the host's version and its current package;
/// the manifest only for `ok`, which the device checks itself.
pub async fn offer(
    State(state): State<AppState>,
    _device: AuthDevice,
) -> Result<Json<DeviceUpdateOffer>, ApiError> {
    let Some(store) = state.updates.as_ref() else {
        return Ok(Json(DeviceUpdateOffer {
            host_version: crate::HOST_VERSION.to_owned(),
            package: OfferedPackage::unavailable(PackageState::Missing),
        }));
    };
    let package = match crate::updates::serve(store).await {
        Ok(package) => OfferedPackage {
            state: PackageState::Ok,
            manifest: Some(package.manifest_text),
            version: Some(package.version),
            size_bytes: Some(package.size_bytes),
            sha256: Some(package.sha256),
        },
        Err(state) => OfferedPackage::unavailable(state),
    };
    Ok(Json(DeviceUpdateOffer {
        host_version: store.host_version().to_owned(),
        package,
    }))
}
