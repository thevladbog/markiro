//! Making the site the run works on: the wizard, one product with its
//! templates, small SSCC blocks (so the half rule fires within minutes),
//! the line's limit, the devices (stations and handhelds) paired and put on
//! the line, and a shift every device enters. Everything goes through the
//! host's own routes, as the owner's setup does.

use std::sync::Arc;
use std::time::Duration;

use markiro_proto::DeviceKind;
use serde_json::{json, Value};

use crate::api::{Api, Auth, Reply};
use crate::host::Host;
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::rng::Rng;

pub type Res<T> = Result<T, String>;

const STATION_VERSION: &str = "1.1.0";
const HANDHELD_VERSION: &str = "1.2.0";
/// A pairing claim is limited to 10 a minute from one address.
const CLAIMS_PER_MINUTE: u32 = 9;

#[derive(Debug, Clone)]
pub struct DeviceSpec {
    pub index: u32,
    pub kind: DeviceKind,
    pub id: String,
    pub key: String,
    pub name: String,
}

impl DeviceSpec {
    pub fn is_handheld(&self) -> bool {
        self.kind == DeviceKind::Handheld
    }

    /// What the device names in its entry of a shift.
    pub fn supports(&self) -> Vec<&'static str> {
        if self.is_handheld() {
            vec!["handheld-host-v1", "multi-station-v1"]
        } else {
            vec!["multi-station-v1"]
        }
    }
}

/// An administrator's session on the host, through one station's key.
#[derive(Clone)]
pub struct Office {
    pub api: Api,
    pub key: String,
    pub token: String,
}

impl Office {
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Res<Reply> {
        let auth = Auth {
            device_key: Some(&self.key),
            session: Some(&self.token),
        };
        self.api
            .send(Route::Other, method, path, auth, body.as_ref())
            .await
            .map_err(|error| format!("{method} {path}: {error:?}"))
    }

    /// The body of a 2xx answer; any other answer is an error naming it.
    pub async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Res<Value> {
        let reply = self.call(method, path, body).await?;
        if reply.ok() {
            Ok(reply.body)
        } else {
            Err(format!("{method} {path}: {} {}", reply.status, reply.body))
        }
    }
}

/// How an attached host is reached: an office station's key and an
/// administrator's login, read from the environment (never the command line).
#[derive(Debug, Clone)]
pub struct AttachCredentials {
    pub office_device_key: String,
    pub login: String,
    pub password: String,
}

#[derive(Clone)]
pub struct Site {
    pub office: Office,
    pub devices: Vec<DeviceSpec>,
    pub line_id: String,
    pub product_id: String,
    pub box_template_id: String,
    pub pallet_template_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftInfo {
    pub id: String,
    pub number: String,
    pub issuer_prefix: String,
}

fn str_of<'a>(value: &'a Value, pointer: &str) -> Res<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no {pointer} in {value}"))
}

async fn device_call(
    api: &Api,
    route: Route,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Res<Value> {
    let auth = Auth {
        device_key: Some(key),
        session: None,
    };
    let reply = api
        .send(route, method, path, auth, body.as_ref())
        .await
        .map_err(|error| format!("{method} {path}: {error:?}"))?;
    if reply.ok() {
        Ok(reply.body)
    } else {
        Err(format!("{method} {path}: {} {}", reply.status, reply.body))
    }
}

/// A password only this run knows: the site is a throwaway, but the command
/// the host runs under listens on the network for the run's length.
fn throwaway_password(rng: &mut Rng) -> String {
    format!("Load-{:016x}-{:016x}", rng.next_u64(), rng.next_u64())
}

/// A site ready for `profile`: see the module's text.
pub async fn provision(
    host: &Host,
    metrics: Arc<Metrics>,
    profile: &Profile,
    attach: Option<AttachCredentials>,
) -> Res<(Site, ShiftInfo)> {
    let api = Api::new(&host.base, &host.fingerprint, metrics.clone());
    let mut rng = Rng::new(profile.seed ^ 0x51_7E);
    let mut devices = Vec::new();
    // The office station: the first station, which also works the shift when
    // the host is the harness's own.
    let (office_key, token) = match attach {
        Some(credentials) => {
            let session = device_call(
                &api,
                Route::Other,
                &credentials.office_device_key,
                "POST",
                "/v1/office/login",
                Some(json!({ "login": credentials.login, "password": credentials.password })),
            )
            .await?;
            (
                credentials.office_device_key,
                str_of(&session, "/token")?.to_owned(),
            )
        }
        None => {
            let paired = pair_local(&api, "Нагрузка станция 1").await?;
            let password = throwaway_password(&mut rng);
            let body = json!({
                "admin": { "login": "admin", "name": "Нагрузка", "password": password },
                "org": {
                    "name": "ООО «Нагрузка»", "inn": "7707083893", "gln": "4600682000010",
                    "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow"
                },
                "sscc": { "boxNextSerial": 1500, "palletNextSerial": 40 },
                "lines": ["Линия 1", "Линия 2"]
            });
            let done = device_call(
                &api,
                Route::Other,
                &paired.key,
                "POST",
                "/v1/bootstrap",
                Some(body),
            )
            .await?;
            let token = str_of(&done, "/session/token")?.to_owned();
            devices.push(paired);
            (devices[0].key.clone(), token)
        }
    };
    let office = Office {
        api: api.clone(),
        key: office_key,
        token,
    };
    // Small blocks: with the default 2000 a device would never ask twice.
    let sscc = office.ok("GET", "/v1/office/sscc", None).await?;
    let rev = sscc
        .get("blockSizesRev")
        .and_then(Value::as_i64)
        .ok_or("no blockSizesRev")?;
    office
        .ok(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({
                "boxBlockSize": profile.box_block_size,
                "palletBlockSize": profile.pallet_block_size.max(1),
                "expectedRev": rev
            })),
        )
        .await?;
    let box_template = office
        .ok(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": "Короб 58×40", "purpose": "box", "enabled": true,
                "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
            })),
        )
        .await?;
    let pallet_template_id = if profile.pallet_boxes > 0 {
        let pallet = office
            .ok(
                "POST",
                "/v1/office/templates",
                Some(json!({
                    "name": "Паллета 100×150", "purpose": "pallet", "enabled": true,
                    "chzProductGroupCodes": null,
                    "spec": { "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": [] }
                })),
            )
            .await?;
        Some(str_of(&pallet, "/id")?.to_owned())
    } else {
        None
    };
    let product = office
        .ok(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": crate::gen::GTIN14, "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
                "chzProductGroupCode": 8, "boxCapacity": profile.box_capacity,
                "palletBoxCapacity": profile.pallet_boxes.max(1), "shelfLifeDays": 10
            })),
        )
        .await?;
    let lines = office.ok("GET", "/v1/office/lines", None).await?;
    let line = lines
        .as_array()
        .and_then(|lines| lines.iter().find(|line| line["name"] == "Линия 1"))
        .ok_or("the wizard made no «Линия 1»")?;
    let line_id = str_of(line, "/id")?.to_owned();
    if profile.devices() > 1 {
        let rev = line
            .get("rev")
            .and_then(Value::as_i64)
            .ok_or("no line rev")?;
        office
            .ok(
                "PUT",
                &format!("/v1/office/lines/{line_id}"),
                Some(json!({ "maxStations": profile.devices(), "expectedRev": rev })),
            )
            .await?;
    }
    // The rest of the devices.
    let mut claims = 0u32;
    while (devices.iter().filter(|d| !d.is_handheld()).count() as u32) < profile.stations {
        let at = devices.len() as u32 + 1;
        let name = format!("Нагрузка станция {at}");
        let spec = if host.local {
            pair_local(&api, &name).await?
        } else {
            claim(&office, DeviceKind::Station, &name, &mut claims).await?
        };
        devices.push(spec);
    }
    for at in 1..=profile.handhelds {
        let name = format!("Нагрузка ТСД {at}");
        devices.push(claim(&office, DeviceKind::Handheld, &name, &mut claims).await?);
    }
    for (index, device) in devices.iter_mut().enumerate() {
        device.index = index as u32;
        if device.is_handheld() {
            office
                .ok(
                    "PUT",
                    &format!("/v1/office/devices/{}", device.id),
                    Some(json!({ "name": device.name, "lineId": line_id })),
                )
                .await?;
        } else {
            device_call(
                &api,
                Route::Other,
                &device.key,
                "PUT",
                "/v1/device/line",
                Some(json!({ "lineId": line_id })),
            )
            .await?;
        }
    }
    let site = Site {
        office,
        devices,
        line_id,
        product_id: str_of(&product, "/id")?.to_owned(),
        box_template_id: str_of(&box_template, "/id")?.to_owned(),
        pallet_template_id,
    };
    let shift = plan_and_enter(&site, profile, None).await?;
    Ok((site, shift))
}

async fn pair_local(api: &Api, name: &str) -> Res<DeviceSpec> {
    let paired = api
        .send(
            Route::Other,
            "POST",
            "/v1/local-pair",
            Auth::default(),
            Some(&json!({ "kind": "station", "name": name, "appVersion": STATION_VERSION })),
        )
        .await
        .map_err(|error| format!("local-pair: {error:?}"))?;
    if !paired.ok() {
        return Err(format!("local-pair: {} {}", paired.status, paired.body));
    }
    Ok(DeviceSpec {
        index: 0,
        kind: DeviceKind::Station,
        id: str_of(&paired.body, "/deviceId")?.to_owned(),
        key: str_of(&paired.body, "/deviceKey")?.to_owned(),
        name: name.to_owned(),
    })
}

/// A device paired with a code from the office, as a handheld always is.
async fn claim(office: &Office, kind: DeviceKind, name: &str, claims: &mut u32) -> Res<DeviceSpec> {
    if *claims > 0 && *claims % CLAIMS_PER_MINUTE == 0 {
        tokio::time::sleep(Duration::from_secs(61)).await;
    }
    *claims += 1;
    let code = office.ok("POST", "/v1/office/pairing-codes", None).await?;
    let (version, capabilities) = match kind {
        DeviceKind::Handheld => (HANDHELD_VERSION, json!(["handheld-host-v1"])),
        _ => (STATION_VERSION, json!([])),
    };
    let paired = office
        .api
        .send(
            Route::Other,
            "POST",
            "/v1/pairing/claim",
            Auth::default(),
            Some(&json!({
                "code": str_of(&code, "/code")?, "kind": kind.as_str(), "name": name,
                "appVersion": version, "capabilities": capabilities
            })),
        )
        .await
        .map_err(|error| format!("claim: {error:?}"))?;
    if !paired.ok() {
        return Err(format!("claim: {} {}", paired.status, paired.body));
    }
    Ok(DeviceSpec {
        index: 0,
        kind,
        id: str_of(&paired.body, "/deviceId")?.to_owned(),
        key: str_of(&paired.body, "/deviceKey")?.to_owned(),
        name: name.to_owned(),
    })
}

/// Plan a shift on the site's line and have every device enter it: the first
/// entry opens it. Used for the run's shift and for each drill's.
pub async fn plan_and_enter(
    site: &Site,
    profile: &Profile,
    planned_qty: Option<u32>,
) -> Res<ShiftInfo> {
    let mut body = json!({
        "productId": site.product_id, "lineId": site.line_id,
        "productionDate": "2026-10-08", "boxTemplateId": site.box_template_id,
        "boxCapacity": profile.box_capacity
    });
    if let Some(template) = &site.pallet_template_id {
        body["palletsEnabled"] = json!(true);
        body["palletTemplateId"] = json!(template);
        body["palletBoxCapacity"] = json!(profile.pallet_boxes);
    }
    if let Some(planned) = planned_qty {
        body["plannedQty"] = json!(planned);
    }
    let shift = site
        .office
        .ok("POST", "/v1/office/shifts", Some(body))
        .await?;
    let id = str_of(&shift, "/id")?.to_owned();
    let number = str_of(&shift, "/number")?.to_owned();
    let mut issuer_prefix = None;
    for device in &site.devices {
        let entered = device_call(
            &site.office.api,
            Route::Enter,
            &device.key,
            "POST",
            &format!("/v1/device/shifts/{id}/enter"),
            Some(json!({ "supports": device.supports() })),
        )
        .await?;
        if let Some(prefix) = entered
            .pointer("/snapshot/issuerPrefix")
            .and_then(Value::as_str)
        {
            issuer_prefix.get_or_insert_with(|| prefix.to_owned());
        }
    }
    let issuer_prefix = issuer_prefix.ok_or("no entry answered a snapshot")?;
    Ok(ShiftInfo {
        id,
        number,
        issuer_prefix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_station_site_is_made_through_the_hosts_own_routes() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let mut profile = Profile::preset("tiny").unwrap();
        profile.stations = 1;
        profile.handhelds = 0;
        let (site, shift) = provision(&host, Arc::new(Metrics::new()), &profile, None)
            .await
            .unwrap();
        assert_eq!(site.devices.len(), 1);
        assert_eq!(shift.issuer_prefix, "460068200");
        assert_eq!(shift.number, "OCT26-001");
        let listed = site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
        host.stop().await.unwrap();
    }

    #[test]
    fn a_device_names_what_it_supports() {
        let spec = |kind| DeviceSpec {
            index: 0,
            kind,
            id: String::new(),
            key: String::new(),
            name: String::new(),
        };
        assert_eq!(
            spec(DeviceKind::Station).supports(),
            vec!["multi-station-v1"]
        );
        assert_eq!(
            spec(DeviceKind::Handheld).supports(),
            vec!["handheld-host-v1", "multi-station-v1"]
        );
    }
}
