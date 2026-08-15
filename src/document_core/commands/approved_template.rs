//! 승인된 단순 템플릿의 좁은 가상 필드 편집 계약.
//!
//! 화면 좌표가 아니라 HWP IR의 표/문단 주소와 해시를 사용한다. 사전 검증과 실제 적용은
//! 같은 해석 함수를 거치며, 적용은 내부 스냅샷과 batch pagination으로 전부 성공하거나
//! 전부 되돌아간다. 범용 문서 자동화나 복합 문서 편집 표면이 아니다.

use std::collections::HashSet;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::document_core::queries::table_extract::{extract_tables, TableGrid};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::Paragraph;
use crate::model::shape::ShapeObject;
use crate::model::table::{Cell, Table};
use crate::parser::FileFormat;
use crate::renderer::{hwpunit_to_px, DEFAULT_DPI};

const MAX_TARGETS: usize = 100;
const MAX_VALUE_CHARS: usize = 20_000;
const MAX_VALUE_LINES: usize = 1_000;
const MAX_INSPECTION_CANDIDATES: usize = 2_000;
const MAX_REQUEST_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTableCell {
    pub section_index: usize,
    pub paragraph_index: usize,
    pub control_index: usize,
    pub cell_index: usize,
    pub paragraph_lengths: Vec<usize>,
    pub old_text: String,
}

#[derive(Debug, Clone)]
pub enum CellResolveError {
    Usage(String),
    Runtime(String),
}

/// `export-tables`의 최상위 표 번호와 앵커 좌표를 실제 IR 셀 주소로 해석한다.
///
/// CLI `edit set-cell`, MCP 세션 편집, 승인 템플릿 API가 공유하는 단일 구현이다.
pub fn resolve_table_cell_details(
    document: &Document,
    table_no: usize,
    row: u16,
    col: u16,
) -> Result<ResolvedTableCell, CellResolveError> {
    let grids = extract_tables(document);
    let Some(grid) = grids
        .iter()
        .find(|grid| grid.index == table_no && grid.container_path.is_empty())
    else {
        let top_level = grids
            .iter()
            .filter(|grid| grid.container_path.is_empty())
            .count();
        return Err(CellResolveError::Runtime(format!(
            "오류: 본문 최상위 표 {table_no} 번이 없습니다 (최상위 표 {top_level}개; 중첩 표는 v1 범위 밖)."
        )));
    };
    let Some(Control::Table(table)) = document.sections[grid.section].paragraphs[grid.paragraph]
        .controls
        .get(grid.control)
    else {
        return Err(CellResolveError::Runtime(
            "오류: 표 컨트롤 좌표 해석 실패 (내부 불일치).".into(),
        ));
    };
    if row >= table.row_count || col >= table.col_count {
        return Err(CellResolveError::Usage(format!(
            "오류: 좌표가 격자를 벗어났습니다 — 표 {table_no} 는 {}x{} 입니다.",
            table.row_count, table.col_count
        )));
    }
    match table
        .cells
        .iter()
        .enumerate()
        .find(|(_, cell)| cell.row == row && cell.col == col)
    {
        Some((cell_index, cell)) => Ok(ResolvedTableCell {
            section_index: grid.section,
            paragraph_index: grid.paragraph,
            control_index: grid.control,
            cell_index,
            paragraph_lengths: cell
                .paragraphs
                .iter()
                .map(|paragraph| paragraph.text.chars().count())
                .collect(),
            old_text: cell_text(cell),
        }),
        None => {
            let anchor = table.cells.iter().find(|cell| {
                cell.row <= row
                    && row < cell.row.saturating_add(cell.row_span)
                    && cell.col <= col
                    && col < cell.col.saturating_add(cell.col_span)
            });
            Err(CellResolveError::Usage(match anchor {
                Some(anchor) => format!(
                    "오류: ({row},{col}) 는 병합으로 덮인 칸입니다 — 앵커 ({},{}) 를 지정하세요.",
                    anchor.row, anchor.col
                ),
                None => format!("오류: ({row},{col}) 위치에 셀이 없습니다."),
            }))
        }
    }
}

#[allow(clippy::type_complexity)]
pub fn resolve_table_cell(
    document: &Document,
    table_no: usize,
    row: u16,
    col: u16,
) -> Result<(usize, usize, usize, usize, Vec<usize>, String), CellResolveError> {
    resolve_table_cell_details(document, table_no, row, col).map(|resolved| {
        (
            resolved.section_index,
            resolved.paragraph_index,
            resolved.control_index,
            resolved.cell_index,
            resolved.paragraph_lengths,
            resolved.old_text,
        )
    })
}

/// 기존 set-cell과 같은 근사 폭 계산으로 셀 overflow를 보고한다.
pub fn measure_cell_overflow(
    core: &DocumentCore,
    section_index: usize,
    paragraph_index: usize,
    control_index: usize,
    cell_index: usize,
    text: &str,
) -> Option<(f64, f64, usize)> {
    if text.is_empty() {
        return None;
    }
    let cell = table_cell(
        core.document(),
        section_index,
        paragraph_index,
        control_index,
        cell_index,
    )?;
    let horizontal_padding = (cell.padding.left + cell.padding.right) as f64;
    let usable_width = hwpunit_to_px((cell.width as f64 - horizontal_padding) as i32, DEFAULT_DPI);
    if usable_width <= 0.0 {
        return None;
    }
    let line_widths: Vec<_> = text
        .split('\n')
        .map(|line| {
            estimate_text_width_px(
                core,
                section_index,
                paragraph_index,
                control_index,
                cell_index,
                line,
            )
        })
        .collect();
    let text_width = line_widths.iter().copied().fold(0.0_f64, f64::max);
    if text_width <= usable_width {
        return None;
    }
    let wrapped_lines = line_widths
        .iter()
        .map(|width| (width / usable_width).ceil().max(1.0) as usize)
        .sum();
    Some((usable_width, text_width, wrapped_lines))
}

fn estimate_text_width_px(
    core: &DocumentCore,
    section_index: usize,
    paragraph_index: usize,
    control_index: usize,
    cell_index: usize,
    text: &str,
) -> f64 {
    let size_hwpunit = table_cell(
        core.document(),
        section_index,
        paragraph_index,
        control_index,
        cell_index,
    )
    .and_then(|cell| cell.paragraphs.first())
    .and_then(|paragraph| paragraph.char_shapes.first())
    .and_then(|shape_ref| {
        core.document()
            .doc_info
            .char_shapes
            .get(shape_ref.char_shape_id as usize)
    })
    .map(|shape| shape.base_size as f64)
    .unwrap_or(1000.0);
    let em = hwpunit_to_px(size_hwpunit as i32, DEFAULT_DPI);
    text.chars()
        .map(|character| if character.is_ascii() { em * 0.5 } else { em })
        .sum()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovedTemplateEditRequestV1 {
    schema_version: u8,
    template_id: String,
    expected_structure_digest: String,
    targets: Vec<ApprovedEditTargetV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ApprovedEditTargetV1 {
    NativeField {
        target_id: String,
        field_id: u32,
        expected_value_hash: String,
        value: String,
        max_chars: usize,
        max_lines: usize,
    },
    BodyPlaceholder {
        target_id: String,
        section_index: usize,
        paragraph_index: usize,
        expected_text_hash: String,
        adjacent_label_digest: String,
        value: String,
        max_chars: usize,
        max_lines: usize,
    },
    TableCell {
        target_id: String,
        table_index: usize,
        row: u16,
        col: u16,
        expected_text_hash: String,
        adjacent_label_digest: String,
        merged_anchor: MergedAnchorV1,
        value: String,
        max_chars: usize,
        max_lines: usize,
        keep_style: bool,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MergedAnchorV1 {
    row: u16,
    col: u16,
}

impl ApprovedEditTargetV1 {
    fn target_id(&self) -> &str {
        match self {
            Self::NativeField { target_id, .. }
            | Self::BodyPlaceholder { target_id, .. }
            | Self::TableCell { target_id, .. } => target_id,
        }
    }

    fn value(&self) -> &str {
        match self {
            Self::NativeField { value, .. }
            | Self::BodyPlaceholder { value, .. }
            | Self::TableCell { value, .. } => value,
        }
    }

    fn max_chars(&self) -> usize {
        match self {
            Self::NativeField { max_chars, .. }
            | Self::BodyPlaceholder { max_chars, .. }
            | Self::TableCell { max_chars, .. } => *max_chars,
        }
    }

    fn max_lines(&self) -> usize {
        match self {
            Self::NativeField { max_lines, .. }
            | Self::BodyPlaceholder { max_lines, .. }
            | Self::TableCell { max_lines, .. } => *max_lines,
        }
    }
}

#[derive(Debug, Clone)]
enum ResolvedEdit {
    NativeField {
        target_id: String,
        field_id: u32,
        old_value: String,
        value: String,
    },
    BodyPlaceholder {
        target_id: String,
        section_index: usize,
        paragraph_index: usize,
        old_value: String,
        value: String,
    },
    TableCell {
        target_id: String,
        resolved: ResolvedTableCell,
        old_value: String,
        value: String,
    },
}

impl ResolvedEdit {
    fn target_id(&self) -> &str {
        match self {
            Self::NativeField { target_id, .. }
            | Self::BodyPlaceholder { target_id, .. }
            | Self::TableCell { target_id, .. } => target_id,
        }
    }

    fn old_value(&self) -> &str {
        match self {
            Self::NativeField { old_value, .. }
            | Self::BodyPlaceholder { old_value, .. }
            | Self::TableCell { old_value, .. } => old_value,
        }
    }

    fn value(&self) -> &str {
        match self {
            Self::NativeField { value, .. }
            | Self::BodyPlaceholder { value, .. }
            | Self::TableCell { value, .. } => value,
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct ComplexityStats {
    table_count: usize,
    nested_table_count: usize,
    picture_count: usize,
    shape_count: usize,
}

#[derive(Debug)]
struct PreflightState {
    result: serde_json::Value,
    edits: Vec<ResolvedEdit>,
    changed_paragraphs: Vec<(usize, usize)>,
    token: Option<String>,
}

impl DocumentCore {
    /// 구조 digest와 해시 기반 등록 후보를 반환한다. 원문 텍스트는 포함하지 않는다.
    pub fn inspect_approved_template_json(&self) -> String {
        let structure_digest = approved_structure_digest(self.document());
        let stats = complexity_stats(self.document());
        let protection = protection_json(self.page_count(), stats);
        let grids = extract_tables(self.document());

        let mut body_candidates = Vec::new();
        for (section_index, section) in self.document().sections.iter().enumerate() {
            for (paragraph_index, paragraph) in section.paragraphs.iter().enumerate() {
                if body_candidates.len() >= MAX_INSPECTION_CANDIDATES {
                    break;
                }
                if !paragraph.text.is_empty() && body_paragraph_is_safe(paragraph) {
                    body_candidates.push(serde_json::json!({
                        "sectionIndex": section_index,
                        "paragraphIndex": paragraph_index,
                        "textHash": text_hash(&paragraph.text),
                        "adjacentLabelDigest": body_adjacent_label_digest(
                            &section.paragraphs,
                            paragraph_index,
                        ),
                    }));
                }
            }
        }

        let mut table_cells = Vec::new();
        for grid in grids.iter().filter(|grid| grid.container_path.is_empty()) {
            let Some(Control::Table(table)) = self.document().sections[grid.section].paragraphs
                [grid.paragraph]
                .controls
                .get(grid.control)
            else {
                continue;
            };
            for (cell_index, cell) in table.cells.iter().enumerate() {
                if table_cells.len() >= MAX_INSPECTION_CANDIDATES {
                    break;
                }
                let blocked_reasons = cell_blocked_reasons(cell);
                table_cells.push(serde_json::json!({
                    "tableIndex": grid.index,
                    "row": cell.row,
                    "col": cell.col,
                    "rowSpan": cell.row_span,
                    "colSpan": cell.col_span,
                    "mergedAnchor": { "row": cell.row, "col": cell.col },
                    "textHash": text_hash(&cell_text(cell)),
                    "adjacentLabelDigest": adjacent_label_digest(table, cell.row, cell.col),
                    "safe": blocked_reasons.is_empty(),
                    "blockedReasons": blocked_reasons,
                    "resolvedAddress": {
                        "sectionIndex": grid.section,
                        "paragraphIndex": grid.paragraph,
                        "controlIndex": grid.control,
                        "cellIndex": cell_index,
                    },
                }));
            }
        }

        let native_fields: Vec<_> = self
            .collect_all_fields()
            .into_iter()
            .filter(|field| field.field.ctrl_id != 0)
            .map(|field| {
                serde_json::json!({
                    "fieldId": field.field.field_id,
                    "editable": field.field.is_editable_in_form(),
                    "valueHash": text_hash(&field.value),
                })
            })
            .collect();

        serde_json::json!({
            "schemaVersion": 1,
            "format": source_format_name(self.source_format),
            "structureDigest": structure_digest,
            "pageCount": self.page_count(),
            "sectionCount": self.document().sections.len(),
            "paragraphCount": self.document().sections.iter().map(|s| s.paragraphs.len()).sum::<usize>(),
            "topLevelTableCount": grids.iter().filter(|grid| grid.container_path.is_empty()).count(),
            "nestedTableCount": stats.nested_table_count,
            "pictureCount": stats.picture_count,
            "shapeCount": stats.shape_count,
            "binDataCount": self.document().bin_data_content.len(),
            "protection": protection,
            "nativeFields": native_fields,
            "bodyCandidates": body_candidates,
            "tableCells": table_cells,
            "truncated": body_candidates.len() >= MAX_INSPECTION_CANDIDATES
                || table_cells.len() >= MAX_INSPECTION_CANDIDATES,
        })
        .to_string()
    }

    /// 문서를 바꾸지 않고 요청 전체를 검증한다.
    pub fn preflight_approved_template_edits_native(
        &mut self,
        request_json: &str,
    ) -> Result<String, HwpError> {
        Ok(self
            .preflight_approved_template_edits(request_json)?
            .result
            .to_string())
    }

    /// 유효한 preflight token을 재검증한 뒤 요청 전체를 원자 적용한다.
    pub fn apply_approved_template_edits_native(
        &mut self,
        request_json: &str,
        preflight_token: &str,
    ) -> Result<String, HwpError> {
        let preflight = self.preflight_approved_template_edits(request_json)?;
        if preflight.result["ok"] != serde_json::Value::Bool(true) {
            return Ok(preflight.result.to_string());
        }
        if preflight.token.as_deref() != Some(preflight_token) {
            return Ok(failed_apply_result("stale-preflight", Vec::new()).to_string());
        }

        let snapshot_id = self.save_snapshot_native();
        if let Err(error) = self.begin_batch_native() {
            self.discard_snapshot_native(snapshot_id);
            return Err(error);
        }
        let mut updated = 0usize;
        let apply_result: Result<(), HwpError> = (|| {
            for edit in &preflight.edits {
                if edit.old_value() == edit.value() {
                    continue;
                }
                match edit {
                    ResolvedEdit::NativeField {
                        field_id, value, ..
                    } => {
                        self.set_field_value_by_id(*field_id, value)?;
                    }
                    ResolvedEdit::BodyPlaceholder {
                        section_index,
                        paragraph_index,
                        old_value,
                        value,
                        ..
                    } => {
                        if !old_value.is_empty() {
                            self.delete_text_native(
                                *section_index,
                                *paragraph_index,
                                0,
                                old_value.chars().count(),
                            )?;
                        }
                        if !value.is_empty() {
                            self.insert_text_native(*section_index, *paragraph_index, 0, value)?;
                        }
                    }
                    ResolvedEdit::TableCell {
                        resolved, value, ..
                    } => {
                        let old_len = resolved.paragraph_lengths.first().copied().unwrap_or(0);
                        if old_len > 0 {
                            self.delete_text_in_cell_native(
                                resolved.section_index,
                                resolved.paragraph_index,
                                resolved.control_index,
                                resolved.cell_index,
                                0,
                                0,
                                old_len,
                            )?;
                        }
                        if !value.is_empty() {
                            self.insert_text_in_cell_native(
                                resolved.section_index,
                                resolved.paragraph_index,
                                resolved.control_index,
                                resolved.cell_index,
                                0,
                                0,
                                value,
                            )?;
                        }
                    }
                }
                updated += 1;
            }
            self.end_batch_native()?;
            Ok(())
        })();

        if let Err(error) = apply_result {
            self.batch_mode = false;
            let restore = self.restore_snapshot_native(snapshot_id);
            self.discard_snapshot_native(snapshot_id);
            return match restore {
                Ok(_) => Err(error),
                Err(rollback_error) => Err(HwpError::RenderError(format!(
                    "승인 템플릿 적용 실패 후 rollback도 실패했습니다: {error}; {rollback_error}"
                ))),
            };
        }
        self.discard_snapshot_native(snapshot_id);

        let changed_pages = if updated == 0 {
            Vec::new()
        } else {
            self.pages_covering_paragraphs(&preflight.changed_paragraphs)
                .unwrap_or_default()
        };
        Ok(serde_json::json!({
            "schemaVersion": 1,
            "ok": true,
            "updated": updated,
            "changedPages": changed_pages,
            "warnings": preflight.result["warnings"].clone(),
            "overflowTargets": preflight.result["overflowTargets"].clone(),
            "rejectedTargets": [],
            "reason": serde_json::Value::Null,
        })
        .to_string())
    }

    fn preflight_approved_template_edits(
        &mut self,
        request_json: &str,
    ) -> Result<PreflightState, HwpError> {
        if request_json.len() > MAX_REQUEST_BYTES {
            return Ok(PreflightState {
                result: failed_preflight_result("invalid-request", Vec::new()),
                edits: Vec::new(),
                changed_paragraphs: Vec::new(),
                token: None,
            });
        }
        let request: ApprovedTemplateEditRequestV1 = serde_json::from_str(request_json)
            .map_err(|error| HwpError::RenderError(format!("승인 편집 요청 JSON 오류: {error}")))?;
        let structure_digest = approved_structure_digest(self.document());
        let mut rejected = Vec::new();
        let mut warnings = Vec::new();
        let mut overflow_targets = Vec::new();
        let mut edits = Vec::new();
        let mut changed_paragraphs = Vec::new();

        if request.schema_version != 1
            || !safe_target_id(&request.template_id)
            || request.targets.is_empty()
            || request.targets.len() > MAX_TARGETS
        {
            return Ok(PreflightState {
                result: failed_preflight_result("invalid-request", rejected),
                edits,
                changed_paragraphs,
                token: None,
            });
        }

        let mut ids = HashSet::new();
        let mut addresses = HashSet::new();
        for target in &request.targets {
            if !safe_target_id(target.target_id()) || !ids.insert(target.target_id().to_string()) {
                rejected.push(rejected_target(
                    target.target_id(),
                    "invalid-or-duplicate-target-id",
                ));
            }
            let value_chars = target.value().chars().count();
            if target.max_chars() == 0
                || target.max_chars() > MAX_VALUE_CHARS
                || value_chars > target.max_chars()
                || value_chars > MAX_VALUE_CHARS
                || has_unsafe_text_control(target.value())
            {
                rejected.push(rejected_target(target.target_id(), "invalid-value"));
            }
            if target.max_lines() == 0 || target.max_lines() > MAX_VALUE_LINES {
                rejected.push(rejected_target(target.target_id(), "invalid-max-lines"));
            } else if value_line_count(target.value()) > target.max_lines() {
                rejected.push(rejected_target(target.target_id(), "max-lines-exceeded"));
            }
            let address = match target {
                ApprovedEditTargetV1::NativeField { field_id, .. } => {
                    format!("native:{field_id}")
                }
                ApprovedEditTargetV1::BodyPlaceholder {
                    section_index,
                    paragraph_index,
                    ..
                } => format!("body:{section_index}:{paragraph_index}"),
                ApprovedEditTargetV1::TableCell {
                    table_index,
                    row,
                    col,
                    ..
                } => format!("cell:{table_index}:{row}:{col}"),
            };
            if !addresses.insert(address) {
                rejected.push(rejected_target(
                    target.target_id(),
                    "duplicate-target-address",
                ));
            }
        }

        let native_count = request
            .targets
            .iter()
            .filter(|target| matches!(target, ApprovedEditTargetV1::NativeField { .. }))
            .count();
        let body_count = request
            .targets
            .iter()
            .filter(|target| matches!(target, ApprovedEditTargetV1::BodyPlaceholder { .. }))
            .count();
        let cell_count = request
            .targets
            .iter()
            .filter(|target| matches!(target, ApprovedEditTargetV1::TableCell { .. }))
            .count();
        if (native_count > 0 && native_count != request.targets.len())
            || body_count > 1
            || cell_count > 1
            || (body_count > 0 && cell_count > 0)
        {
            for target in &request.targets {
                rejected.push(rejected_target(
                    target.target_id(),
                    "mixed-or-multiple-virtual-targets",
                ));
            }
        }

        let stats = complexity_stats(self.document());
        if protection_status(self.page_count(), stats) == "protected" {
            for target in &request.targets {
                rejected.push(rejected_target(target.target_id(), "protected-document"));
            }
        }
        if request.expected_structure_digest != structure_digest {
            for target in &request.targets {
                rejected.push(rejected_target(target.target_id(), "structure-mismatch"));
            }
        }
        if !rejected.is_empty() {
            deduplicate_rejections(&mut rejected);
            return Ok(PreflightState {
                result: failed_preflight_result("preflight-rejected", rejected),
                edits,
                changed_paragraphs,
                token: None,
            });
        }

        let fields = self.collect_all_fields();
        for target in &request.targets {
            match target {
                ApprovedEditTargetV1::NativeField {
                    target_id,
                    field_id,
                    expected_value_hash,
                    value,
                    ..
                } => {
                    let Some(field) = fields
                        .iter()
                        .find(|field| field.field.field_id == *field_id)
                    else {
                        rejected.push(rejected_target(target_id, "unknown-field"));
                        continue;
                    };
                    if field.field.ctrl_id == 0 || !field.field.is_editable_in_form() {
                        rejected.push(rejected_target(target_id, "unsupported-field"));
                        continue;
                    }
                    if text_hash(&field.value) != *expected_value_hash && field.value != *value {
                        rejected.push(rejected_target(target_id, "target-text-mismatch"));
                        continue;
                    }
                    changed_paragraphs
                        .push((field.location.section_index, field.location.para_index));
                    edits.push(ResolvedEdit::NativeField {
                        target_id: target_id.clone(),
                        field_id: *field_id,
                        old_value: field.value.clone(),
                        value: value.clone(),
                    });
                }
                ApprovedEditTargetV1::BodyPlaceholder {
                    target_id,
                    section_index,
                    paragraph_index,
                    expected_text_hash,
                    adjacent_label_digest: expected_labels,
                    value,
                    ..
                } => {
                    let Some(paragraph) = self
                        .document()
                        .sections
                        .get(*section_index)
                        .and_then(|section| section.paragraphs.get(*paragraph_index))
                    else {
                        rejected.push(rejected_target(target_id, "unknown-body-paragraph"));
                        continue;
                    };
                    if !body_paragraph_is_safe(paragraph) {
                        rejected.push(rejected_target(target_id, "mixed-body-content"));
                        continue;
                    }
                    if text_hash(&paragraph.text) != *expected_text_hash && paragraph.text != *value
                    {
                        rejected.push(rejected_target(target_id, "target-text-mismatch"));
                        continue;
                    }
                    if body_adjacent_label_digest(
                        &self.document().sections[*section_index].paragraphs,
                        *paragraph_index,
                    ) != *expected_labels
                    {
                        rejected.push(rejected_target(target_id, "adjacent-label-mismatch"));
                        continue;
                    }
                    changed_paragraphs.push((*section_index, *paragraph_index));
                    edits.push(ResolvedEdit::BodyPlaceholder {
                        target_id: target_id.clone(),
                        section_index: *section_index,
                        paragraph_index: *paragraph_index,
                        old_value: paragraph.text.clone(),
                        value: value.clone(),
                    });
                }
                ApprovedEditTargetV1::TableCell {
                    target_id,
                    table_index,
                    row,
                    col,
                    expected_text_hash,
                    adjacent_label_digest: expected_labels,
                    merged_anchor,
                    value,
                    max_lines,
                    keep_style,
                    ..
                } => {
                    if !*keep_style || merged_anchor.row != *row || merged_anchor.col != *col {
                        rejected.push(rejected_target(target_id, "unsafe-cell-options"));
                        continue;
                    }
                    let resolved =
                        match resolve_table_cell_details(self.document(), *table_index, *row, *col)
                        {
                            Ok(resolved) => resolved,
                            Err(CellResolveError::Usage(message)) => {
                                let reason = if message.contains("병합으로 덮인") {
                                    "covered-merged-cell"
                                } else {
                                    "invalid-cell-address"
                                };
                                rejected.push(rejected_target(target_id, reason));
                                continue;
                            }
                            Err(CellResolveError::Runtime(_)) => {
                                rejected
                                    .push(rejected_target(target_id, "unknown-or-nested-table"));
                                continue;
                            }
                        };
                    let Some(Control::Table(table)) = self.document().sections
                        [resolved.section_index]
                        .paragraphs[resolved.paragraph_index]
                        .controls
                        .get(resolved.control_index)
                    else {
                        rejected.push(rejected_target(target_id, "structure-mismatch"));
                        continue;
                    };
                    let Some(cell) = table.cells.get(resolved.cell_index) else {
                        rejected.push(rejected_target(target_id, "structure-mismatch"));
                        continue;
                    };
                    if !cell_blocked_reasons(cell).is_empty() {
                        rejected.push(rejected_target(target_id, "mixed-cell-content"));
                        continue;
                    }
                    if text_hash(&resolved.old_text) != *expected_text_hash
                        && resolved.old_text != *value
                    {
                        rejected.push(rejected_target(target_id, "target-text-mismatch"));
                        continue;
                    }
                    if adjacent_label_digest(table, *row, *col) != *expected_labels {
                        rejected.push(rejected_target(target_id, "adjacent-label-mismatch"));
                        continue;
                    }
                    if let Some((cell_width, text_width, lines)) = measure_cell_overflow(
                        self,
                        resolved.section_index,
                        resolved.paragraph_index,
                        resolved.control_index,
                        resolved.cell_index,
                        value,
                    ) {
                        overflow_targets.push(serde_json::json!({
                            "targetId": target_id,
                            "cellWidthPx": round2(cell_width),
                            "textWidthPx": round2(text_width),
                            "lines": lines,
                            "maxLines": max_lines,
                        }));
                        if lines > *max_lines {
                            rejected.push(rejected_target(target_id, "confirmed-overflow"));
                            continue;
                        }
                        warnings.push(serde_json::json!({
                            "targetId": target_id,
                            "code": "cell-wrap-expected",
                        }));
                    }
                    changed_paragraphs.push((resolved.section_index, resolved.paragraph_index));
                    edits.push(ResolvedEdit::TableCell {
                        target_id: target_id.clone(),
                        old_value: resolved.old_text.clone(),
                        value: value.clone(),
                        resolved,
                    });
                }
            }
        }
        if !rejected.is_empty() {
            deduplicate_rejections(&mut rejected);
            return Ok(PreflightState {
                result: serde_json::json!({
                    "schemaVersion": 1,
                    "ok": false,
                    "updated": 0,
                    "changedPages": serde_json::Value::Null,
                    "preflightToken": serde_json::Value::Null,
                    "targets": [],
                    "warnings": warnings,
                    "overflowTargets": overflow_targets,
                    "rejectedTargets": rejected,
                    "reason": "preflight-rejected",
                }),
                edits: Vec::new(),
                changed_paragraphs: Vec::new(),
                token: None,
            });
        }

        changed_paragraphs.sort_unstable();
        changed_paragraphs.dedup();
        let changed_pages = self
            .pages_covering_paragraphs(&changed_paragraphs)
            .unwrap_or_default();
        if !changed_pages.is_empty() {
            warnings.push(serde_json::json!({
                "targetId": serde_json::Value::Null,
                "code": "changed-pages-conservative",
            }));
        }
        let token = preflight_token(&structure_digest, &request)?;
        let targets: Vec<_> = edits
            .iter()
            .map(|edit| {
                serde_json::json!({
                    "targetId": edit.target_id(),
                    "originalValue": edit.old_value(),
                    "proposedValue": edit.value(),
                    "changed": edit.old_value() != edit.value(),
                })
            })
            .collect();
        let result = serde_json::json!({
            "schemaVersion": 1,
            "ok": true,
            "updated": 0,
            "changedPages": changed_pages,
            "preflightToken": token,
            "targets": targets,
            "warnings": warnings,
            "overflowTargets": overflow_targets,
            "rejectedTargets": [],
            "reason": serde_json::Value::Null,
        });
        Ok(PreflightState {
            result,
            edits,
            changed_paragraphs,
            token: Some(token),
        })
    }
}

fn failed_preflight_result(reason: &str, rejected: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "ok": false,
        "updated": 0,
        "changedPages": serde_json::Value::Null,
        "preflightToken": serde_json::Value::Null,
        "targets": [],
        "warnings": [],
        "overflowTargets": [],
        "rejectedTargets": rejected,
        "reason": reason,
    })
}

fn failed_apply_result(reason: &str, rejected: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "ok": false,
        "updated": 0,
        "changedPages": [],
        "warnings": [],
        "overflowTargets": [],
        "rejectedTargets": rejected,
        "reason": reason,
    })
}

fn rejected_target(target_id: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({ "targetId": target_id, "reason": reason })
}

fn deduplicate_rejections(rejected: &mut Vec<serde_json::Value>) {
    let mut seen = HashSet::new();
    rejected.retain(|entry| {
        seen.insert((
            entry["targetId"].as_str().unwrap_or_default().to_string(),
            entry["reason"].as_str().unwrap_or_default().to_string(),
        ))
    });
}

fn preflight_token(
    structure_digest: &str,
    request: &ApprovedTemplateEditRequestV1,
) -> Result<String, HwpError> {
    let mut hasher = Sha256::new();
    hasher.update(b"rhwp-approved-template-preflight-v1\0");
    hasher.update(structure_digest.as_bytes());
    hasher.update(
        serde_json::to_vec(request).map_err(|error| {
            HwpError::RenderError(format!("preflight token 생성 실패: {error}"))
        })?,
    );
    Ok(prefixed_sha256(hasher.finalize().as_slice()))
}

fn approved_structure_digest(document: &Document) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rhwp-approved-template-structure-v1\0");
    hash_usize(&mut hasher, document.sections.len());
    hash_usize(&mut hasher, document.bin_data_content.len());
    for section in &document.sections {
        hash_section_layout(&mut hasher, &section.section_def);
        hash_usize(&mut hasher, section.paragraphs.len());
        hash_paragraphs(&mut hasher, &section.paragraphs);
    }
    prefixed_sha256(hasher.finalize().as_slice())
}

fn hash_paragraphs(hasher: &mut Sha256, paragraphs: &[Paragraph]) {
    for paragraph in paragraphs {
        hasher.update(paragraph.para_shape_id.to_le_bytes());
        hasher.update(paragraph.style_id.to_le_bytes());
        hash_usize(hasher, paragraph.controls.len());
        for control in &paragraph.controls {
            hash_control(hasher, control);
        }
    }
}

fn hash_control(hasher: &mut Sha256, control: &Control) {
    match control {
        Control::SectionDef(_) => hasher.update(b"section-def"),
        Control::ColumnDef(_) => hasher.update(b"column-def"),
        Control::Table(table) => {
            hasher.update(b"table");
            hasher.update(table.attr.to_le_bytes());
            hasher.update(table.row_count.to_le_bytes());
            hasher.update(table.col_count.to_le_bytes());
            hasher.update(table.cell_spacing.to_le_bytes());
            hash_padding(hasher, &table.padding);
            hasher.update(table.border_fill_id.to_le_bytes());
            hasher.update([match table.page_break {
                crate::model::table::TablePageBreak::None => 0,
                crate::model::table::TablePageBreak::CellBreak => 1,
                crate::model::table::TablePageBreak::RowBreak => 2,
            }]);
            hasher.update([u8::from(table.repeat_header)]);
            hasher.update(table.common.horizontal_offset.to_le_bytes());
            hasher.update(table.common.width.to_le_bytes());
            hasher.update([u8::from(table.common.treat_as_char)]);
            hash_usize(hasher, table.zones.len());
            for zone in &table.zones {
                hasher.update(zone.start_col.to_le_bytes());
                hasher.update(zone.start_row.to_le_bytes());
                hasher.update(zone.end_col.to_le_bytes());
                hasher.update(zone.end_row.to_le_bytes());
                hasher.update(zone.border_fill_id.to_le_bytes());
            }
            hash_usize(hasher, table.cells.len());
            for cell in &table.cells {
                hasher.update(cell.row.to_le_bytes());
                hasher.update(cell.col.to_le_bytes());
                hasher.update(cell.row_span.to_le_bytes());
                hasher.update(cell.col_span.to_le_bytes());
                hasher.update(cell.width.to_le_bytes());
                hash_padding(hasher, &cell.padding);
                hasher.update(cell.border_fill_id.to_le_bytes());
                hasher.update([cell.text_direction]);
                hasher.update([match cell.vertical_align {
                    crate::model::table::VerticalAlign::Top => 0,
                    crate::model::table::VerticalAlign::Center => 1,
                    crate::model::table::VerticalAlign::Bottom => 2,
                }]);
                hasher.update([
                    u8::from(cell.apply_inner_margin),
                    u8::from(cell.is_header),
                    u8::from(cell.cell_protect()),
                ]);
                hash_usize(hasher, cell.paragraphs.len());
                hash_paragraphs(hasher, &cell.paragraphs);
            }
        }
        Control::Shape(_) => hasher.update(b"shape"),
        Control::Picture(_) => hasher.update(b"picture"),
        Control::Header(header) => {
            hasher.update(b"header");
            hash_paragraphs(hasher, &header.paragraphs);
        }
        Control::Footer(footer) => {
            hasher.update(b"footer");
            hash_paragraphs(hasher, &footer.paragraphs);
        }
        Control::Footnote(note) => {
            hasher.update(b"footnote");
            hash_paragraphs(hasher, &note.paragraphs);
        }
        Control::Endnote(note) => {
            hasher.update(b"endnote");
            hash_paragraphs(hasher, &note.paragraphs);
        }
        Control::AutoNumber(_) => hasher.update(b"auto-number"),
        Control::NewNumber(_) => hasher.update(b"new-number"),
        Control::PageNumberPos(_) => hasher.update(b"page-number"),
        Control::Bookmark(_) => hasher.update(b"bookmark"),
        Control::Hyperlink(_) => hasher.update(b"hyperlink"),
        Control::Ruby(_) => hasher.update(b"ruby"),
        Control::CharOverlap(_) => hasher.update(b"char-overlap"),
        Control::PageHide(_) => hasher.update(b"page-hide"),
        Control::HiddenComment(_) => hasher.update(b"hidden-comment"),
        Control::Equation(_) => hasher.update(b"equation"),
        Control::Field(field) => {
            hasher.update(b"field");
            hasher.update(field.field_id.to_le_bytes());
            hasher.update(field.ctrl_id.to_le_bytes());
        }
        Control::Form(_) => hasher.update(b"form"),
        Control::Unknown(_) => hasher.update(b"unknown"),
    }
}

fn hash_section_layout(hasher: &mut Sha256, section_def: &crate::model::document::SectionDef) {
    hasher.update(b"section-layout");
    hasher.update(section_def.flags.to_le_bytes());
    hasher.update(section_def.column_spacing.to_le_bytes());
    hasher.update(section_def.line_grid.to_le_bytes());
    hasher.update(section_def.char_grid.to_le_bytes());
    hasher.update(section_def.default_tab_spacing.to_le_bytes());
    hasher.update([section_def.text_direction]);
    let page = &section_def.page_def;
    hasher.update(page.width.to_le_bytes());
    hasher.update(page.height.to_le_bytes());
    hasher.update(page.margin_left.to_le_bytes());
    hasher.update(page.margin_right.to_le_bytes());
    hasher.update(page.margin_top.to_le_bytes());
    hasher.update(page.margin_bottom.to_le_bytes());
    hasher.update(page.margin_header.to_le_bytes());
    hasher.update(page.margin_footer.to_le_bytes());
    hasher.update(page.margin_gutter.to_le_bytes());
    hasher.update(page.attr.to_le_bytes());
    hasher.update([u8::from(page.landscape)]);
}

fn hash_padding(hasher: &mut Sha256, padding: &crate::model::Padding) {
    hasher.update(padding.left.to_le_bytes());
    hasher.update(padding.right.to_le_bytes());
    hasher.update(padding.top.to_le_bytes());
    hasher.update(padding.bottom.to_le_bytes());
}

fn hash_usize(hasher: &mut Sha256, value: usize) {
    hasher.update((value as u64).to_le_bytes());
}

fn text_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rhwp-approved-template-text-v1\0");
    hasher.update(text.as_bytes());
    prefixed_sha256(hasher.finalize().as_slice())
}

fn cell_text(cell: &Cell) -> String {
    cell.paragraphs
        .iter()
        .map(|paragraph| paragraph.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn adjacent_label_digest(table: &Table, row: u16, col: u16) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rhwp-approved-template-adjacent-label-v1\0");
    for (label, candidate) in [
        (
            "up",
            row.checked_sub(1).map(|candidate_row| (candidate_row, col)),
        ),
        (
            "left",
            col.checked_sub(1).map(|candidate_col| (row, candidate_col)),
        ),
        (
            "right",
            col.checked_add(1)
                .filter(|candidate_col| *candidate_col < table.col_count)
                .map(|candidate_col| (row, candidate_col)),
        ),
        (
            "down",
            row.checked_add(1)
                .filter(|candidate_row| *candidate_row < table.row_count)
                .map(|candidate_row| (candidate_row, col)),
        ),
    ] {
        hasher.update(label.as_bytes());
        if let Some((candidate_row, candidate_col)) = candidate {
            if let Some(cell) = covering_cell(table, candidate_row, candidate_col) {
                hasher.update(cell.row.to_le_bytes());
                hasher.update(cell.col.to_le_bytes());
                hasher.update(cell.row_span.to_le_bytes());
                hasher.update(cell.col_span.to_le_bytes());
                hasher.update(text_hash(&cell_text(cell)).as_bytes());
            } else {
                hasher.update(b"missing");
            }
        } else {
            hasher.update(b"edge");
        }
    }
    prefixed_sha256(hasher.finalize().as_slice())
}

fn body_adjacent_label_digest(paragraphs: &[Paragraph], paragraph_index: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rhwp-approved-template-body-adjacent-label-v1\0");
    for (label, candidate_index) in [
        ("previous", paragraph_index.checked_sub(1)),
        (
            "next",
            paragraph_index
                .checked_add(1)
                .filter(|index| *index < paragraphs.len()),
        ),
    ] {
        hasher.update(label.as_bytes());
        if let Some(index) = candidate_index {
            let paragraph = &paragraphs[index];
            hasher.update(paragraph.para_shape_id.to_le_bytes());
            hasher.update(paragraph.style_id.to_le_bytes());
            hasher.update(text_hash(&paragraph.text).as_bytes());
        } else {
            hasher.update(b"edge");
        }
    }
    prefixed_sha256(hasher.finalize().as_slice())
}

fn prefixed_sha256(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(7 + bytes.len() * 2);
    output.push_str("sha256:");
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn covering_cell(table: &Table, row: u16, col: u16) -> Option<&Cell> {
    table.cells.iter().find(|cell| {
        cell.row <= row
            && row < cell.row.saturating_add(cell.row_span)
            && cell.col <= col
            && col < cell.col.saturating_add(cell.col_span)
    })
}

fn table_cell(
    document: &Document,
    section_index: usize,
    paragraph_index: usize,
    control_index: usize,
    cell_index: usize,
) -> Option<&Cell> {
    document
        .sections
        .get(section_index)?
        .paragraphs
        .get(paragraph_index)?
        .controls
        .get(control_index)
        .and_then(|control| match control {
            Control::Table(table) => table.cells.get(cell_index),
            _ => None,
        })
}

fn body_paragraph_is_safe(paragraph: &Paragraph) -> bool {
    paragraph
        .controls
        .iter()
        .all(|control| matches!(control, Control::SectionDef(_) | Control::ColumnDef(_)))
        && !paragraph.text.contains('\u{fffc}')
}

fn cell_blocked_reasons(cell: &Cell) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if cell.paragraphs.len() != 1 {
        reasons.push("multiple-paragraphs");
    }
    if cell
        .paragraphs
        .iter()
        .any(|paragraph| !paragraph.controls.is_empty() || paragraph.text.contains('\u{fffc}'))
    {
        reasons.push("mixed-control-content");
    }
    reasons
}

fn complexity_stats(document: &Document) -> ComplexityStats {
    fn visit_paragraphs(paragraphs: &[Paragraph], inside_table: bool, stats: &mut ComplexityStats) {
        for paragraph in paragraphs {
            for control in &paragraph.controls {
                match control {
                    Control::Table(table) => {
                        stats.table_count += 1;
                        if inside_table {
                            stats.nested_table_count += 1;
                        }
                        for cell in &table.cells {
                            visit_paragraphs(&cell.paragraphs, true, stats);
                        }
                    }
                    Control::Picture(_) => stats.picture_count += 1,
                    Control::Shape(shape) => {
                        stats.shape_count += 1;
                        if matches!(shape.as_ref(), ShapeObject::Picture(_)) {
                            stats.picture_count += 1;
                        }
                    }
                    Control::Header(header) => visit_paragraphs(&header.paragraphs, false, stats),
                    Control::Footer(footer) => visit_paragraphs(&footer.paragraphs, false, stats),
                    Control::Footnote(note) => visit_paragraphs(&note.paragraphs, false, stats),
                    Control::Endnote(note) => visit_paragraphs(&note.paragraphs, false, stats),
                    _ => {}
                }
            }
        }
    }

    let mut stats = ComplexityStats::default();
    for section in &document.sections {
        visit_paragraphs(&section.paragraphs, false, &mut stats);
    }
    stats
}

fn protection_status(page_count: u32, stats: ComplexityStats) -> &'static str {
    let reasons = protection_reasons(page_count, stats);
    if stats.nested_table_count > 0 || stats.table_count >= 20 || reasons.len() >= 2 {
        "protected"
    } else {
        "standard"
    }
}

fn protection_reasons(page_count: u32, stats: ComplexityStats) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if page_count >= 4 {
        reasons.push("many-pages");
    }
    if stats.table_count >= 12 {
        reasons.push("many-tables");
    }
    if stats.picture_count >= 5 {
        reasons.push("many-images");
    }
    if stats.nested_table_count > 0 {
        reasons.push("nested-tables");
    }
    if stats.shape_count >= 5 {
        reasons.push("mixed-drawing-objects");
    }
    reasons
}

fn protection_json(page_count: u32, stats: ComplexityStats) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "status": protection_status(page_count, stats),
        "pageCount": page_count,
        "tableCount": stats.table_count,
        "nestedTableCount": stats.nested_table_count,
        "pictureCount": stats.picture_count,
        "shapeCount": stats.shape_count,
        "reasons": protection_reasons(page_count, stats),
    })
}

fn source_format_name(format: FileFormat) -> &'static str {
    match format {
        FileFormat::Hwp => "hwp",
        FileFormat::Hwpx => "hwpx",
        FileFormat::Hwp3 => "hwp3",
        FileFormat::Hml => "hml",
        FileFormat::DrmProtected => "drm-protected",
        FileFormat::Empty => "empty",
        FileFormat::Unknown => "unknown",
    }
}

fn safe_target_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.:".contains(character))
}

fn has_unsafe_text_control(value: &str) -> bool {
    value.chars().any(|character| {
        character == '\u{fffc}'
            || character == '\u{7f}'
            || (character <= '\u{1f}' && character != '\n')
            || character == '\u{0000}'
    })
}

fn value_line_count(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }
    let semantic_lines = value.lines().count();
    let explicit_lines = value.bytes().filter(|byte| *byte == b'\n').count() + 1;
    semantic_lines.max(explicit_lines)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
