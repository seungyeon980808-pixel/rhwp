use crate::document_core::DocumentCore;
use crate::model::bin_data::{BinDataType, MAX_BIN_DATA_BYTES};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

impl DocumentCore {
    pub fn get_binary_resource_manifest_native(&self) -> String {
        let mut resources = Vec::new();
        let mut missing = BTreeSet::new();
        let mut seen = BTreeSet::new();
        for content in &self.document.bin_data_content {
            let id = format!("bin:{}", content.id);
            if !seen.insert(content.id) {
                missing.insert(format!("duplicate-resource:{id}"));
                continue;
            }
            match content.data.load_limited_shared(MAX_BIN_DATA_BYTES) {
                Some(bytes) if !bytes.is_empty() => resources.push(serde_json::json!({
                    "id": id, "sha256": Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                })),
                _ => { missing.insert(format!("resource-bytes:{id}")); }
            }
        }
        for (index, entry) in self.document.doc_info.bin_data_list.iter().enumerate() {
            if entry.data_type == BinDataType::Link {
                missing.insert(format!("external-resource:{index}"));
            } else if !seen.contains(&entry.storage_id) {
                missing.insert(format!("resource-bytes:bin:{}", entry.storage_id));
            }
        }
        resources.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        serde_json::json!({ "resources": resources, "missing": missing }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;
    use crate::model::bin_data::{BinData, BinDataContent, BinDataType};

    #[test]
    fn collaboration_raw_resources_include_unrendered_bytes_and_fail_closed() {
        let mut core = DocumentCore::new_empty();
        core.document.bin_data_content = vec![BinDataContent {
            id: 7,
            data: b"abc".to_vec().into(),
            extension: "ole".into(),
        }];
        let manifest: serde_json::Value =
            serde_json::from_str(&core.get_binary_resource_manifest_native()).unwrap();
        assert_eq!(manifest["resources"][0]["id"], "bin:7");
        assert_eq!(
            manifest["resources"][0]["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(manifest["missing"], serde_json::json!([]));
        core.document.doc_info.bin_data_list.push(BinData {
            data_type: BinDataType::Embedding,
            storage_id: 9,
            ..Default::default()
        });
        core.document.bin_data_content.push(BinDataContent {
            id: 8,
            data: Vec::new().into(),
            extension: "png".into(),
        });
        let manifest: serde_json::Value =
            serde_json::from_str(&core.get_binary_resource_manifest_native()).unwrap();
        assert_eq!(manifest["resources"].as_array().unwrap().len(), 1);
        assert_eq!(
            manifest["missing"],
            serde_json::json!(["resource-bytes:bin:8", "resource-bytes:bin:9"])
        );
    }
}
