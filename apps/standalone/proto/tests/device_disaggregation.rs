use markiro_proto::device_disaggregation::*;
use serde::{de::DeserializeOwned, Serialize};
fn fixture<T: DeserializeOwned + Serialize>(text: &str) {
    let expected: serde_json::Value = serde_json::from_str(text).unwrap();
    let value: T = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(serde_json::to_value(value).unwrap(), expected);
}
#[test]
fn fixtures_pin_lookup_apply_and_answer() {
    fixture::<PackInspection>(include_str!("../fixtures/device-pack-inspection.json"));
    fixture::<PackDisassemble>(include_str!("../fixtures/device-pack-disassemble.json"));
    fixture::<PackDisassembled>(include_str!("../fixtures/device-pack-disassembled.json"));
    let mut request: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/device-pack-disassemble.json")).unwrap();
    request["deviceId"] = serde_json::json!("forged-device");
    assert!(serde_json::from_value::<PackDisassemble>(request).is_err());
}
