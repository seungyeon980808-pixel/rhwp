use std::ffi::OsString;
use std::fs;

use rhwp::wasm_api::HwpDocument;

const COMPLEX_COPY_ENV: &str = "RHWP_APPROVED_COMPLEX_COPY";

#[test]
fn approved_complex_copy_is_protected_and_preflight_is_read_only() {
    let Some(copy_path): Option<OsString> = std::env::var_os(COMPLEX_COPY_ENV) else {
        eprintln!("approved complex protection test skipped: copy env is unset");
        return;
    };
    let before_bytes = fs::read(&copy_path).expect("approved complex copy bytes must be readable");
    let mut document = HwpDocument::from_bytes(&before_bytes)
        .expect("approved complex copy must parse without a password");
    let before_inspection: serde_json::Value =
        serde_json::from_str(&document.inspect_approved_template_json())
            .expect("approved complex inspection must be valid JSON");
    assert_eq!(
        before_inspection["protection"]["status"], "protected",
        "approved complex copy must remain outside the editable template scope"
    );
    let request = serde_json::json!({
        "schemaVersion": 1,
        "templateId": "complex-protection-probe",
        "expectedStructureDigest": before_inspection["structureDigest"],
        "targets": [{
            "kind": "body-placeholder",
            "targetId": "synthetic-probe",
            "sectionIndex": 0,
            "paragraphIndex": 0,
            "expectedTextHash": format!("sha256:{}", "0".repeat(64)),
            "adjacentLabelDigest": format!("sha256:{}", "0".repeat(64)),
            "value": "SYNTHETIC",
            "maxChars": 20,
            "maxLines": 1
        }]
    });
    let preflight: serde_json::Value = serde_json::from_str(
        &document
            .preflight_approved_template_edits_native(&request.to_string())
            .expect("protected preflight must return a structured result"),
    )
    .expect("protected preflight result must be valid JSON");
    assert_eq!(preflight["ok"], false);
    assert!(
        preflight["rejectedTargets"]
            .as_array()
            .expect("protected preflight must list rejected targets")
            .iter()
            .any(|entry| entry["reason"] == "protected-document"),
        "complex copy must be rejected by the product-core protection gate"
    );

    let after_inspection: serde_json::Value =
        serde_json::from_str(&document.inspect_approved_template_json())
            .expect("post-preflight inspection must be valid JSON");
    assert_eq!(
        before_inspection, after_inspection,
        "preflight must not change document structure or protection statistics"
    );
    let after_bytes = fs::read(&copy_path).expect("approved complex copy must remain readable");
    assert_eq!(
        before_bytes, after_bytes,
        "preflight must not write the supplied copy"
    );
}
