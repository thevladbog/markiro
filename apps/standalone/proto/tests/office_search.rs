use markiro_proto::office_search::{OfficeSearchRequest, OfficeSearchResponse};
use serde_json::Value;

#[test]
fn shared_search_fixtures_round_trip() {
    for (text, request) in [
        (include_str!("../fixtures/office-search-request.json"), true),
        (
            include_str!("../fixtures/office-search-response.json"),
            false,
        ),
    ] {
        let original: Value = serde_json::from_str(text).unwrap();
        let encoded = if request {
            serde_json::to_value(
                serde_json::from_value::<OfficeSearchRequest>(original.clone()).unwrap(),
            )
            .unwrap()
        } else {
            serde_json::to_value(
                serde_json::from_value::<OfficeSearchResponse>(original.clone()).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(original, encoded);
    }
    assert!(serde_json::from_str::<OfficeSearchRequest>(
        r#"{"kind":"code","codeHash":"a","raw":"secret"}"#
    )
    .is_err());
}
