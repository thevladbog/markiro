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
use crate::secret::{Redactions, Secret};

pub type Res<T> = Result<T, String>;

const STATION_VERSION: &str = "1.1.0";
const HANDHELD_VERSION: &str = "1.2.0";
/// A pairing claim is limited to 10 a minute from one address.
const CLAIMS_PER_MINUTE: u32 = 9;
/// The lines the wizard makes, in the order `Site.line_ids` keeps them.
const LINE_NAMES: [&str; 3] = ["Линия 1", "Линия 2", "Линия 3"];

#[derive(Debug, Clone)]
pub struct DeviceSpec {
    pub index: u32,
    pub kind: DeviceKind,
    pub id: String,
    pub key: Secret,
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
    pub key: Secret,
    pub token: Secret,
}

impl Office {
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Res<Reply> {
        let auth = Auth {
            device_key: Some(self.key.expose()),
            session: Some(self.token.expose()),
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
    pub office_device_key: Secret,
    pub login: String,
    pub password: Secret,
}

#[derive(Clone)]
pub struct Site {
    pub office: Office,
    pub devices: Vec<DeviceSpec>,
    pub line_id: String,
    /// Every line of `LINE_NAMES` the host has, in that order; `line_ids[0] == line_id`. A fresh
    /// site has all three (an attached host may have only the first).
    pub line_ids: Vec<String>,
    pub product_id: String,
    pub box_template_id: String,
    pub pallet_template_id: Option<String>,
    /// What the run made or was given that must never reach a file it
    /// writes: the administrator's password, pairing codes, device keys and
    /// the session token.
    pub redactions: Redactions,
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

/// A password only this run knows: the site is a throwaway, but a spawned host listens on the
/// network for the run's length. It comes from the operating system's random source (through
/// the TLS provider the harness already links), not from `profile.seed`, which the report writes
/// and which has a default: everything else of a run stays repeatable from its seed.
fn throwaway_password() -> Res<String> {
    let mut bytes = [0u8; 16];
    rustls::crypto::aws_lc_rs::default_provider()
        .secure_random
        .fill(&mut bytes)
        .map_err(|_| "the operating system's random source failed".to_owned())?;
    let hex = |half: &[u8]| {
        half.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    Ok(format!("Load-{}-{}", hex(&bytes[..8]), hex(&bytes[8..])))
}

/// A site ready for `profile`, with no shift: see the module's text.
pub async fn provision_site(
    host: &Host,
    metrics: Arc<Metrics>,
    profile: &Profile,
    attach: Option<AttachCredentials>,
) -> Res<Site> {
    let api = Api::new(&host.base, &host.fingerprint, metrics.clone());
    let mut devices = Vec::new();
    let mut redactions = Redactions::default();
    // The office station: the first station, which also works the shift when
    // the host is the harness's own.
    let (office_key, token) = match attach {
        Some(credentials) => {
            redactions.push(credentials.office_device_key.clone());
            redactions.push(credentials.password.clone());
            let session = device_call(
                &api,
                Route::Other,
                credentials.office_device_key.expose(),
                "POST",
                "/v1/office/login",
                Some(json!({
                    "login": credentials.login,
                    "password": credentials.password.expose()
                })),
            )
            .await?;
            (
                credentials.office_device_key,
                Secret::new(str_of(&session, "/token")?),
            )
        }
        None => {
            let paired = pair_local(&api, "Нагрузка станция 1").await?;
            let password = throwaway_password()?;
            redactions.push(Secret::new(password.clone()));
            let body = json!({
                "admin": { "login": "admin", "name": "Нагрузка", "password": password },
                "org": {
                    "name": "ООО «Нагрузка»", "inn": "7707083893", "gln": "4600682000010",
                    "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow"
                },
                "sscc": { "boxNextSerial": 1500, "palletNextSerial": 40 },
                "lines": LINE_NAMES
            });
            let done = device_call(
                &api,
                Route::Other,
                paired.key.expose(),
                "POST",
                "/v1/bootstrap",
                Some(body),
            )
            .await?;
            let token = Secret::new(str_of(&done, "/session/token")?);
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
            claim(
                &office,
                DeviceKind::Station,
                &name,
                &mut claims,
                &mut redactions,
            )
            .await?
        };
        devices.push(spec);
    }
    for at in 1..=profile.handhelds {
        let name = format!("Нагрузка ТСД {at}");
        devices.push(
            claim(
                &office,
                DeviceKind::Handheld,
                &name,
                &mut claims,
                &mut redactions,
            )
            .await?,
        );
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
                device.key.expose(),
                "PUT",
                "/v1/device/line",
                Some(json!({ "lineId": line_id })),
            )
            .await?;
        }
    }
    redactions.push(office.token.clone());
    redactions.push(office.key.clone());
    for device in &devices {
        redactions.push(device.key.clone());
    }
    let line_ids: Vec<String> = LINE_NAMES
        .iter()
        .filter_map(|name| {
            lines.as_array().and_then(|all| {
                all.iter()
                    .find(|line| line["name"] == *name)
                    .and_then(|line| line["id"].as_str())
                    .map(str::to_owned)
            })
        })
        .collect();
    Ok(Site {
        office,
        devices,
        line_id,
        line_ids,
        product_id: str_of(&product, "/id")?.to_owned(),
        box_template_id: str_of(&box_template, "/id")?.to_owned(),
        pallet_template_id,
        redactions,
    })
}

/// A site ready for `profile` and a shift every device entered: see the module's text.
pub async fn provision(
    host: &Host,
    metrics: Arc<Metrics>,
    profile: &Profile,
    attach: Option<AttachCredentials>,
) -> Res<(Site, ShiftInfo)> {
    let site = provision_site(host, metrics, profile, attach).await?;
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
        key: Secret::new(str_of(&paired.body, "/deviceKey")?),
        name: name.to_owned(),
    })
}

/// A device paired with a code from the office, as a handheld always is.
async fn claim(
    office: &Office,
    kind: DeviceKind,
    name: &str,
    claims: &mut u32,
    redactions: &mut Redactions,
) -> Res<DeviceSpec> {
    if *claims > 0 && *claims % CLAIMS_PER_MINUTE == 0 {
        tokio::time::sleep(Duration::from_secs(61)).await;
    }
    *claims += 1;
    let code = office.ok("POST", "/v1/office/pairing-codes", None).await?;
    if let Some(pairing) = code.pointer("/code").and_then(Value::as_str) {
        redactions.push(Secret::new(pairing));
    }
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
        key: Secret::new(str_of(&paired.body, "/deviceKey")?),
        name: name.to_owned(),
    })
}

/// A planned shift on `line_id` of the site's product and templates, pallets when the site has a
/// pallet template, and a plan when `planned_qty` is given: its id and number. Nobody enters it.
pub async fn plan_shift(
    site: &Site,
    profile: &Profile,
    line_id: &str,
    planned_qty: Option<u32>,
) -> Res<(String, String)> {
    let mut body = json!({
        "productId": site.product_id, "lineId": line_id,
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
    Ok((
        str_of(&shift, "/id")?.to_owned(),
        str_of(&shift, "/number")?.to_owned(),
    ))
}

/// Plan a shift on the site's line and have every device enter it: the first
/// entry opens it. Used for the run's shift and for each drill's.
pub async fn plan_and_enter(
    site: &Site,
    profile: &Profile,
    planned_qty: Option<u32>,
) -> Res<ShiftInfo> {
    let (id, number) = plan_shift(site, profile, &site.line_id, planned_qty).await?;
    let mut issuer_prefix = None;
    for device in &site.devices {
        let entered = device_call(
            &site.office.api,
            Route::Enter,
            device.key.expose(),
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
        assert_eq!(site.line_ids.len(), 3, "the wizard makes three lines");
        assert_eq!(site.line_ids[0], site.line_id);
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

    /// The administrator's password comes from the OS's random source, not from the seed the
    /// report writes: two sites of one seed get two passwords, and each is among the secrets the
    /// reports are redacted of.
    #[tokio::test]
    async fn two_sites_of_one_seed_get_different_passwords_that_are_redacted() {
        let mut passwords = Vec::new();
        for _ in 0..2 {
            let dir = tempfile::tempdir().unwrap();
            let mut host = Host::in_process(dir.path()).await.unwrap();
            let mut profile = Profile::preset("tiny").unwrap();
            profile.stations = 1;
            profile.handhelds = 0;
            let site = provision_site(&host, Arc::new(Metrics::new()), &profile, None)
                .await
                .unwrap();
            host.stop().await.unwrap();
            let password = site
                .redactions
                .iter()
                .find(|secret| secret.expose().starts_with("Load-"))
                .expect("the password is among the secrets")
                .expose()
                .to_owned();
            assert_eq!(password.len(), "Load-".len() + 32 + 1, "{password}");
            let mut report = crate::report::sample_passing();
            report
                .checks
                .push(crate::checks::Check::new("x", false, password.clone()));
            let clean = crate::report::redact(&report, &site.redactions);
            assert!(!serde_json::to_string(&clean).unwrap().contains(&password));
            passwords.push(password);
        }
        assert_ne!(passwords[0], passwords[1], "the password followed the seed");
    }

    /// A device's key and an attached host's credentials never reach a formatted text: a
    /// `{:?}` of what holds them (a failed check's detail, a panic) says only that they are
    /// redacted.
    #[test]
    fn what_holds_a_credential_prints_none_of_it() {
        let spec = DeviceSpec {
            index: 0,
            kind: DeviceKind::Station,
            id: "device-1".to_owned(),
            key: "KEY-0123456789abcdef".into(),
            name: "station".to_owned(),
        };
        let printed = format!("{spec:?}");
        assert!(printed.contains("device-1"), "the id is still printed");
        assert!(
            !printed.contains("KEY-0123456789abcdef"),
            "the device key is printed"
        );
        let credentials = AttachCredentials {
            office_device_key: "KEY-office-fedcba".into(),
            login: "admin".to_owned(),
            password: "Load-hunter2-password".into(),
        };
        let printed = format!("{credentials:?}");
        assert!(printed.contains("admin"), "the login is still printed");
        assert!(
            !printed.contains("KEY-office-fedcba"),
            "the office key is printed"
        );
        assert!(!printed.contains("hunter2"), "the password is printed");
    }

    #[test]
    fn a_device_names_what_it_supports() {
        let spec = |kind| DeviceSpec {
            index: 0,
            kind,
            id: String::new(),
            key: "".into(),
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

    #[tokio::test]
    async fn a_site_without_a_shift_is_made_by_provision_site() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let mut profile = Profile::preset("tiny").unwrap();
        profile.stations = 2;
        profile.handhelds = 1;
        let site = provision_site(&host, Arc::new(Metrics::new()), &profile, None)
            .await
            .unwrap();
        assert_eq!(site.devices.len(), 3);
        let listed = site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(listed.as_array().map(Vec::len), Some(0), "no shift yet");
        let (id, number) = plan_shift(&site, &profile, &site.line_ids[1], Some(40))
            .await
            .unwrap();
        let planned = site
            .office
            .ok("GET", &format!("/v1/office/shifts/{id}"), None)
            .await
            .unwrap();
        assert_eq!(
            (
                planned["status"].as_str(),
                planned["lineId"].as_str(),
                planned["number"].as_str()
            ),
            (
                Some("planned"),
                Some(site.line_ids[1].as_str()),
                Some(number.as_str())
            )
        );
        host.stop().await.unwrap();
    }
}
