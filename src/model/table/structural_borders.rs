//! Structural edits keep outside edges, and never rewrite shared BorderFill records.
use super::Table;
use crate::model::style::{BorderFill, BorderLine, BorderLineType};

fn same_line(a: &BorderLine, b: &BorderLine) -> bool {
    a.line_type == b.line_type && a.width == b.width && a.color == b.color
}

fn style(fills: &[BorderFill], id: u16) -> BorderFill {
    fills
        .get((id as usize).wrapping_sub(1))
        .cloned()
        .unwrap_or_default()
}

fn store(fills: &mut Vec<BorderFill>, mut fill: BorderFill, source: u16) -> Result<u16, String> {
    let original = style(fills, source);
    if fill
        .borders
        .iter()
        .zip(&original.borders)
        .all(|(a, b)| same_line(a, b))
    {
        return Ok(source);
    }
    let id = u16::try_from(fills.len() + 1)
        .map_err(|_| "테두리 서식 수가 범위를 초과합니다".to_string())?;
    fill.raw_data = None;
    fills.push(fill);
    Ok(id)
}

fn priority(line: BorderLine) -> (bool, u8, u8) {
    let kind = match line.line_type {
        BorderLineType::ThinThickThinTriple => 4,
        BorderLineType::Double
        | BorderLineType::ThinThickDouble
        | BorderLineType::ThickThinDouble => 3,
        BorderLineType::Wave | BorderLineType::DoubleWave => 2,
        _ => 1,
    };
    (line.line_type != BorderLineType::None, line.width, kind)
}

impl Table {
    pub fn merge_cells_with_borders(
        &mut self,
        fills: &mut Vec<BorderFill>,
        sr: u16,
        sc: u16,
        er: u16,
        ec: u16,
    ) -> Result<(), String> {
        let mut edited = self.clone();
        edited.merge_cells(sr, sc, er, ec)?;
        let merged = edited
            .cells
            .iter_mut()
            .find(|c| c.row == sr && c.col == sc)
            .unwrap();
        let mut fill = style(fills, merged.border_fill_id);
        for side in 0..4 {
            let edge = self
                .cells
                .iter()
                .filter(|c| {
                    c.row >= sr
                        && c.col >= sc
                        && c.row <= er
                        && c.col <= ec
                        && match side {
                            0 => c.col == sc,
                            1 => c.col as u32 + c.col_span as u32 == ec as u32 + 1,
                            2 => c.row == sr,
                            _ => c.row as u32 + c.row_span as u32 == er as u32 + 1,
                        }
                })
                .map(|c| style(fills, c.border_fill_id).borders[side])
                .max_by_key(|l| priority(*l));
            if let Some(edge) = edge {
                fill.borders[side] = edge;
            }
        }
        merged.border_fill_id = store(fills, fill, merged.border_fill_id)?;
        *self = edited;
        Ok(())
    }

    fn assign_split_borders(
        &mut self,
        fills: &mut Vec<BorderFill>,
        source_id: u16,
        sr: u16,
        sc: u16,
        er: u16,
        ec: u16,
    ) -> Result<(), String> {
        let original = style(fills, source_id);
        // Outside rules can be thicker than ordinary rules. Only use the
        // outside rule on an outside subcell; internal cuts use the thin rule.
        let table_fill = style(fills, self.border_fill_id);
        let inner = original
            .borders
            .iter()
            .chain(table_fill.borders.iter())
            .filter(|l| l.line_type != BorderLineType::None)
            .min_by_key(|l| priority(**l))
            .copied()
            .unwrap_or(BorderLine {
                line_type: BorderLineType::None,
                ..Default::default()
            });
        for cell in &mut self.cells {
            let re = cell.row as u32 + cell.row_span as u32;
            let ce = cell.col as u32 + cell.col_span as u32;
            if cell.row < sr || cell.col < sc || re > er as u32 || ce > ec as u32 {
                continue;
            }
            let mut fill = original.clone();
            if cell.col != sc {
                fill.borders[0] = inner;
            }
            if ce != ec as u32 {
                fill.borders[1] = inner;
            }
            if cell.row != sr {
                fill.borders[2] = inner;
            }
            if re != er as u32 {
                fill.borders[3] = inner;
            }
            cell.border_fill_id = store(fills, fill, source_id)?;
        }
        Ok(())
    }

    pub fn split_cell_with_borders(
        &mut self,
        fills: &mut Vec<BorderFill>,
        row: u16,
        col: u16,
    ) -> Result<(), String> {
        let mut edited = self.clone();
        let old = edited
            .cells
            .iter()
            .find(|c| c.row == row && c.col == col)
            .ok_or_else(|| "분할 셀을 찾을 수 없습니다".to_string())?
            .clone();
        edited.split_cell(row, col)?;
        edited.assign_split_borders(
            fills,
            old.border_fill_id,
            row,
            col,
            row + old.row_span,
            col + old.col_span,
        )?;
        *self = edited;
        Ok(())
    }

    pub fn split_cell_into_with_borders(
        &mut self,
        fills: &mut Vec<BorderFill>,
        row: u16,
        col: u16,
        rows: u16,
        cols: u16,
        equal_height: bool,
        merge_first: bool,
    ) -> Result<(), String> {
        if rows == 1 && cols == 1 {
            return Ok(());
        }
        let mut edited = self.clone();
        let mut source = edited
            .cells
            .iter()
            .find(|c| c.row == row && c.col == col)
            .ok_or_else(|| "분할 셀을 찾을 수 없습니다".to_string())?
            .clone();
        if merge_first && (source.row_span > 1 || source.col_span > 1) {
            edited.split_cell_with_borders(fills, row, col)?;
            source = edited
                .cells
                .iter()
                .find(|c| c.row == row && c.col == col)
                .unwrap()
                .clone();
        }
        let old_rows = edited.row_count;
        let old_cols = edited.col_count;
        edited.split_cell_into(row, col, rows, cols, equal_height, false)?;
        let er = row + source.row_span + (edited.row_count - old_rows);
        // Removing unused cuts can reduce the logical column count. Calculate
        // the new end boundary before subtracting, without unsigned underflow.
        let ec = (col as u32 + source.col_span as u32 + edited.col_count as u32 - old_cols as u32)
            as u16;
        edited.assign_split_borders(fills, source.border_fill_id, row, col, er, ec)?;
        *self = edited;
        Ok(())
    }

    pub fn split_cells_in_range_with_borders(
        &mut self,
        fills: &mut Vec<BorderFill>,
        sr: u16,
        sc: u16,
        er: u16,
        ec: u16,
        rows: u16,
        cols: u16,
        equal_height: bool,
    ) -> Result<(), String> {
        if rows < 1 || cols < 1 {
            return Err("분할 행/열 수는 1 이상이어야 합니다".into());
        }
        let mut edited = self.clone();
        for col in (sc..=ec).rev() {
            for row in (sr..=er).rev() {
                if edited.cells.iter().any(|c| c.row == row && c.col == col) {
                    edited.split_cell_into_with_borders(
                        fills,
                        row,
                        col,
                        rows,
                        cols,
                        equal_height,
                        false,
                    )?;
                }
            }
        }
        *self = edited;
        Ok(())
    }
}
