use markiro_proto::office_pallet_create::{build_pallet_sscc, normalize_sscc};
#[test]
fn office_numbering_and_normalization_match_the_domain_fixtures() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/office-pallet-sscc.json")).unwrap();
    for case in fixture["normalization"].as_array().unwrap() {
        assert_eq!(
            normalize_sscc(case["raw"].as_str().unwrap()),
            case["sscc"].as_str().map(str::to_owned),
            "{case}"
        );
    }
    for case in fixture["allocation"].as_array().unwrap() {
        assert_eq!(
            build_pallet_sscc(
                case["prefix"].as_str().unwrap(),
                case["serial"].as_u64().unwrap()
            ),
            case["sscc"].as_str().map(str::to_owned),
            "{case}"
        );
    }
    assert_eq!(build_pallet_sscc("460068200", 10_000_000), None);
    assert_eq!(build_pallet_sscc("bad", 0), None);
}

#[test]
fn office_creation_wire_fixtures_round_trip() {
    use markiro_proto::{
        OfficePalletCreate, OfficePalletCreated, OfficePalletValidate, OfficePalletValidation,
    };
    fn round<T: serde::de::DeserializeOwned + serde::Serialize>(raw: &str) {
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    round::<OfficePalletValidate>(include_str!(
        "../fixtures/office-pallet-validate-request.json"
    ));
    round::<OfficePalletValidation>(include_str!(
        "../fixtures/office-pallet-validate-response.json"
    ));
    round::<OfficePalletCreate>(include_str!(
        "../fixtures/office-pallet-create-request.json"
    ));
    round::<OfficePalletCreated>(include_str!(
        "../fixtures/office-pallet-create-response.json"
    ));
}
