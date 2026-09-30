//! # acadrust-wasm
//!
//! WebAssembly bridge exposing [acadrust](https://github.com/hakanaktt/acadrust)'s
//! DWG/DXF read-write engine to JavaScript.
//!
//! Everything the viewer needs from the Rust side is a *format conversion*:
//!
//! ```text
//!  .dwg ──dwgToDxf──▶ .dxf ──▶ @mlightcad/data-model native DXF converter ──▶ AcDbDatabase
//!  AcDbDatabase ──▶ .dxf ──dxfToDwg──▶ .dwg
//! ```
//!
//! Parsing a DWG into a *viewer* database is deliberately not done here:
//! `@mlightcad/data-model` already owns that pipeline (layers, linetypes,
//! blocks, proxy entities, progressive rendering), and feeding it DXF keeps a
//! single source of truth for how a drawing becomes a scene.
//!
//! ## Why acadrust
//!
//! cad-viewer's shipped DWG paths are `@mlightcad/libredwg-converter`
//! (GPL-3.0, WASM heap limits on large files) or a commercial closed-source
//! parser. acadrust is MPL-2.0, pure Rust, and reads *and writes* DWG R13
//! through R2018+, which is what makes local "edit then export a real .dwg"
//! possible.
//!
//! ## Error policy
//!
//! Nothing here panics on bad input: every parse/serialize path returns
//! `Result`, so a corrupt upload surfaces as a JavaScript exception the UI can
//! display. Files are always read in *failsafe* mode, meaning recoverable
//! per-record damage is skipped rather than failing the whole drawing.
//!
//! ## Building
//!
//! Use `scripts/build-wasm.sh`, which runs the two required steps (a plain
//! `cargo build --target wasm32-unknown-unknown` followed by
//! `wasm-bindgen --target web`) with a version-matched CLI.

use acadrust::{
    CadDocument, DwgReadOptions, DwgReader, DwgWriter, DxfReader, DxfReaderConfiguration,
    DxfVersion, DxfWriter, EntityType,
};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

/// Revision of the JS-facing API. The TS loader refuses an artifact whose
/// version does not match, which catches "stale .wasm in the build output"
/// without a confusing runtime failure.
pub const ABI_VERSION: u32 = 1;

/// Guard against a pathological drawing turning its layer list into a huge D1
/// row. The summary is metadata, not a faithful inventory.
const MAX_LAYERS_IN_SUMMARY: usize = 512;
const MAX_TYPES_IN_SUMMARY: usize = 64;

fn js_err(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

// ---------------------------------------------------------------------------
// Pure logic (unit-testable on the host, no JS involved)
// ---------------------------------------------------------------------------

/// Map a packed version code (`0` = keep the source version) to a [`DxfVersion`].
fn version_from_code(code: u32) -> Option<DxfVersion> {
    match code {
        0 => None,
        1012 => Some(DxfVersion::AC1012),
        1014 => Some(DxfVersion::AC1014),
        1015 => Some(DxfVersion::AC1015),
        1018 => Some(DxfVersion::AC1018),
        1021 => Some(DxfVersion::AC1021),
        1024 => Some(DxfVersion::AC1024),
        1027 => Some(DxfVersion::AC1027),
        1032 => Some(DxfVersion::AC1032),
        _ => None,
    }
}

/// Result of parsing a drawing, plus the parser's resilience metadata.
struct ParsedDrawing {
    document: CadDocument,
    /// Number of recoverable problems the parser reported.
    diagnostics: usize,
    /// True when the parser had to recover, i.e. the file was damaged.
    recovered: bool,
}

/// Verify a DWG's version tag.
///
/// A DWG starts with the six-byte ASCII code of the format it was written in
/// (`AC1015` for AutoCAD 2000, `AC1032` for 2018+). Checking it first matters a
/// lot for UX: in failsafe mode acadrust reports a *recoverable* failure for a
/// non-DWG and returns an empty document, so without this check a user who
/// uploads a .jpeg would be shown a blank drawing instead of an error.
fn validate_dwg_signature(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 6 {
        return Err("this file is too short to be a DWG drawing".to_string());
    }
    let tag = &bytes[..6];
    let looks_like_version_tag =
        tag.starts_with(b"AC10") && tag[4..6].iter().all(u8::is_ascii_digit);
    if !looks_like_version_tag {
        return Err(format!(
            "this is not a DWG drawing: expected a version tag such as \"AC1032\", found \"{}\"",
            String::from_utf8_lossy(tag).trim()
        ));
    }
    Ok(())
}

/// Verify that a DXF starts like DXF.
///
/// Accepts both containers: binary DXF is identified by its magic string, and
/// ASCII DXF must open with a group-code/`SECTION` pair near the start. Scanning
/// a window rather than an exact prefix tolerates the leading whitespace and
/// line-ending variations that real writers emit.
fn validate_dxf_signature(bytes: &[u8]) -> Result<(), String> {
    const BINARY_DXF_MAGIC: &[u8] = b"AutoCAD Binary DXF";
    if bytes.starts_with(BINARY_DXF_MAGIC) {
        return Ok(());
    }

    let window = &bytes[..bytes.len().min(4096)];
    let head = String::from_utf8_lossy(window);
    if head.contains("SECTION") {
        return Ok(());
    }
    Err("this is not a DXF drawing: no SECTION marker found near the start".to_string())
}

/// Parse a DWG or DXF payload into an in-memory document.
///
/// Both paths run in failsafe mode: a corrupt record is recorded as a
/// diagnostic and skipped instead of aborting the whole drawing, which matters
/// for real-world files. The diagnostics come back so the UI can tell the user
/// a drawing was only partially recovered.
fn read_document(bytes: &[u8], is_dwg: bool) -> Result<ParsedDrawing, String> {
    if bytes.is_empty() {
        return Err("empty input: nothing to parse".to_string());
    }

    if is_dwg {
        validate_dwg_signature(bytes)?;
    } else {
        validate_dxf_signature(bytes)?;
    }

    let outcome = if is_dwg {
        let mut reader = DwgReader::from_stream_with_options(
            Cursor::new(bytes.to_vec()),
            DwgReadOptions::failsafe(),
        );
        reader
            .read_with_stats()
            .map_err(|e| format!("DWG parse failed: {e}"))?
    } else {
        let config = DxfReaderConfiguration {
            failsafe: true,
            ..Default::default()
        };
        DxfReader::from_reader(Cursor::new(bytes.to_vec()))
            .map_err(|e| format!("DXF open failed: {e}"))?
            .with_configuration(config)
            .read_with_stats()
            .map_err(|e| format!("DXF parse failed: {e}"))?
    };

    let diagnostics = outcome.stats.diagnostics.len();
    let recovered = outcome.stats.recovered();
    Ok(ParsedDrawing {
        document: outcome.document,
        diagnostics,
        recovered,
    })
}

/// Serialize a document to DXF (ASCII) or binary DWG.
fn write_document(doc: &CadDocument, to_dwg: bool) -> Result<Vec<u8>, String> {
    let result = if to_dwg {
        DwgWriter::write_to_vec(doc)
    } else {
        DxfWriter::new(doc).write_to_vec()
    };
    result.map_err(|e| format!("serialize failed: {e}"))
}

fn convert_bytes(
    data: &[u8],
    from_dwg: bool,
    to_dwg: bool,
    version_code: u32,
) -> Result<Vec<u8>, String> {
    let mut doc = read_document(data, from_dwg)?.document;
    if let Some(version) = version_from_code(version_code) {
        doc.version = version;
    }
    write_document(&doc, to_dwg)
}

fn json_escape(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `EntityType` → its DXF name, e.g. `LINE`.
fn entity_kind(entity: &EntityType) -> String {
    let name = entity.as_entity().entity_type();
    if !name.is_empty() {
        return name.to_string();
    }
    // Fall back to the enum variant name for entity kinds that do not report one.
    let debug = format!("{entity:?}");
    debug
        .split(['(', '{', ' '])
        .next()
        .unwrap_or("UNKNOWN")
        .to_string()
}

/// Build the JSON metadata summary for a document.
///
/// This is the only drawing-derived payload the app is allowed to persist, so
/// it is intentionally limited to counts, version, layer names and parser
/// health — never geometry.
fn summarize(doc: &CadDocument, is_dwg: bool, diagnostics: usize, recovered: bool) -> String {
    let mut layers: Vec<&str> = doc.layers.iter().map(|layer| layer.name.as_str()).collect();
    let layer_count = layers.len();
    layers.truncate(MAX_LAYERS_IN_SUMMARY);

    let mut type_counts: Vec<(String, usize)> = Vec::new();
    for entity in doc.entities() {
        let kind = entity_kind(entity);
        match type_counts.iter_mut().find(|(name, _)| *name == kind) {
            Some((_, count)) => *count += 1,
            None => type_counts.push((kind, 1)),
        }
    }
    type_counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let type_count_total = type_counts.len();
    type_counts.truncate(MAX_TYPES_IN_SUMMARY);

    let mut json = String::with_capacity(512 + layer_count * 24);
    json.push('{');
    json.push_str("\"format\":");
    json_escape(&mut json, if is_dwg { "dwg" } else { "dxf" });
    json.push_str(",\"version\":");
    json_escape(&mut json, doc.version.as_str());
    json.push_str(",\"entityCount\":");
    json.push_str(&doc.entity_count().to_string());
    json.push_str(",\"modelSpaceEntityCount\":");
    json.push_str(&doc.model_space_entities().count().to_string());
    json.push_str(",\"layerCount\":");
    json.push_str(&layer_count.to_string());
    json.push_str(",\"layerNames\":[");
    for (index, name) in layers.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json_escape(&mut json, name);
    }
    json.push_str("],\"layerNamesTruncated\":");
    json.push_str(if layer_count > layers.len() {
        "true"
    } else {
        "false"
    });
    json.push_str(",\"entityTypes\":{");
    for (index, (name, count)) in type_counts.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json_escape(&mut json, name);
        json.push(':');
        json.push_str(&count.to_string());
    }
    json.push_str("},\"entityTypeCount\":");
    json.push_str(&type_count_total.to_string());
    // Resilience metadata: lets the UI say "opened, with N recovered problems"
    // instead of silently showing a partially readable drawing.
    json.push_str(",\"recovered\":");
    json.push_str(if recovered { "true" } else { "false" });
    json.push_str(",\"diagnostics\":");
    json.push_str(&diagnostics.to_string());
    json.push('}');
    json
}

// ---------------------------------------------------------------------------
// wasm-bindgen surface
// ---------------------------------------------------------------------------

/// API revision; the loader compares this against its own constant.
#[wasm_bindgen(js_name = abiVersion)]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// Version of the bundled `acadrust` crate (e.g. `"0.5.5"`), shown in the
/// app's "About" panel so a deployed build is traceable.
#[wasm_bindgen(js_name = acadrustVersion)]
pub fn acadrust_version() -> String {
    acadrust::VERSION.to_string()
}

/// Generic conversion. `from_dwg`/`to_dwg` select the source and target
/// containers; `version_code` is a DXF version code such as `1032` (AutoCAD
/// 2018), or `0` to keep whatever the source used.
#[wasm_bindgen(js_name = convert)]
pub fn convert(
    data: &[u8],
    from_dwg: bool,
    to_dwg: bool,
    version_code: u32,
) -> Result<Vec<u8>, JsValue> {
    convert_bytes(data, from_dwg, to_dwg, version_code).map_err(js_err)
}

/// DWG → DXF. The path used when opening a `.dwg`.
#[wasm_bindgen(js_name = dwgToDxf)]
pub fn dwg_to_dxf(data: &[u8], version_code: u32) -> Result<Vec<u8>, JsValue> {
    convert_bytes(data, true, false, version_code).map_err(js_err)
}

/// DXF → DWG. The path used by "export as DWG" after local edits.
#[wasm_bindgen(js_name = dxfToDwg)]
pub fn dxf_to_dwg(data: &[u8], version_code: u32) -> Result<Vec<u8>, JsValue> {
    convert_bytes(data, false, true, version_code).map_err(js_err)
}

/// DWG → DWG through acadrust, e.g. to downgrade the file version.
#[wasm_bindgen(js_name = dwgToDwg)]
pub fn dwg_to_dwg(data: &[u8], version_code: u32) -> Result<Vec<u8>, JsValue> {
    convert_bytes(data, true, true, version_code).map_err(js_err)
}

/// DXF → DXF through acadrust, i.e. normalize/re-version a DXF.
#[wasm_bindgen(js_name = dxfToDxf)]
pub fn dxf_to_dxf(data: &[u8], version_code: u32) -> Result<Vec<u8>, JsValue> {
    convert_bytes(data, false, false, version_code).map_err(js_err)
}

/// Parse a drawing and return a JSON summary (counts, version, layer names,
/// parser health).
///
/// Lets the app index an uploaded file in D1 without opening the renderer.
#[wasm_bindgen(js_name = inspect)]
pub fn inspect(data: &[u8], is_dwg: bool) -> Result<String, JsValue> {
    let parsed = read_document(data, is_dwg).map_err(js_err)?;
    Ok(summarize(
        &parsed.document,
        is_dwg,
        parsed.diagnostics,
        parsed.recovered,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use acadrust::types::{Vector2, Vector3};
    use acadrust::{Circle, EntityType, Layer, Line, LwPolyline, Text};

    /// `Result::unwrap_err` needs `Debug` on the Ok type, which `CadDocument`
    /// does not provide cheaply. This asserts the error case without it.
    fn expect_err(result: Result<ParsedDrawing, String>) -> String {
        match result {
            Ok(_) => panic!("expected the parse to fail, but it succeeded"),
            Err(message) => message,
        }
    }

    fn sample_document() -> CadDocument {
        let mut doc = CadDocument::with_version(DxfVersion::AC1032);
        doc.layers.add(Layer::new("WALLS")).unwrap();
        doc.add_entity(EntityType::Line(Line::from_coords(
            0.0, 0.0, 0.0, 100.0, 50.0, 0.0,
        )))
        .unwrap();
        doc.add_entity(EntityType::Circle(Circle::from_center_radius(
            Vector3::new(10.0, 10.0, 0.0),
            5.0,
        )))
        .unwrap();
        doc.add_entity(EntityType::LwPolyline(LwPolyline::from_points(vec![
            Vector2::new(0.0, 0.0),
            Vector2::new(10.0, 0.0),
            Vector2::new(10.0, 10.0),
        ])))
        .unwrap();
        doc.add_entity(EntityType::Text(Text::with_value(
            "hello",
            Vector3::new(1.0, 1.0, 0.0),
        )))
        .unwrap();
        doc
    }

    #[test]
    fn version_codes_map_to_known_versions() {
        assert_eq!(version_from_code(0), None);
        assert_eq!(version_from_code(1032), Some(DxfVersion::AC1032));
        assert_eq!(version_from_code(1015), Some(DxfVersion::AC1015));
        // Unknown codes fall back to "keep the source version".
        assert_eq!(version_from_code(9999), None);
    }

    #[test]
    fn empty_input_is_an_error_not_a_panic() {
        let error = expect_err(read_document(&[], false));
        assert!(error.contains("empty input"), "{error}");
    }

    #[test]
    fn rejects_non_cad_bytes() {
        let junk = b"this is definitely not a drawing".to_vec();
        let error = expect_err(read_document(&junk, true));
        assert!(error.contains("not a DWG"), "{error}");
    }

    #[test]
    fn rejects_a_dwg_with_a_wrong_version_tag() {
        let mut fake = b"AC9999".to_vec();
        fake.extend_from_slice(&[0u8; 64]);
        let error = expect_err(read_document(&fake, true));
        assert!(error.contains("not a DWG"), "{error}");
    }

    #[test]
    fn rejects_a_dxf_without_a_section_marker() {
        let junk = b"; just a comment\n0\nEOF\n".to_vec();
        let error = expect_err(read_document(&junk, false));
        assert!(error.contains("not a DXF"), "{error}");
    }

    #[test]
    fn a_plausible_dwg_signature_passes_the_up_front_check() {
        // A valid version tag gets past signature validation. What the parser
        // then makes of a garbage body is its business: in failsafe mode it
        // recovers an empty document rather than erroring, which is why the
        // signature check exists (otherwise a .jpg would open as a blank
        // drawing instead of being rejected).
        let mut fake = b"AC1032".to_vec();
        fake.extend_from_slice(&[0u8; 4096]);
        match read_document(&fake, true) {
            Ok(parsed) => assert_eq!(parsed.document.entity_count(), 0),
            Err(message) => assert!(!message.contains("not a DWG"), "{message}"),
        }
    }

    #[test]
    fn dxf_round_trip_preserves_entities() {
        let doc = sample_document();
        let dxf = write_document(&doc, false).unwrap();
        let reparsed = read_document(&dxf, false).unwrap();
        assert_eq!(reparsed.document.entity_count(), 4);
        assert!(!reparsed.recovered);
    }

    #[test]
    fn dwg_round_trip_through_dxf() {
        let doc = sample_document();
        let dwg = write_document(&doc, true).unwrap();
        assert!(!dwg.is_empty());
        assert!(dwg.starts_with(b"AC"), "DWG must start with a version tag");

        let back_to_dxf = convert_bytes(&dwg, true, false, 0).unwrap();
        let reparsed = read_document(&back_to_dxf, false).unwrap();
        assert_eq!(reparsed.document.entity_count(), 4);
        assert_eq!(reparsed.document.version, DxfVersion::AC1032);
    }

    #[test]
    fn version_code_downgrades_output() {
        let doc = sample_document();
        let dxf = write_document(&doc, false).unwrap();
        let downgraded = convert_bytes(&dxf, false, false, 1015).unwrap();
        let reparsed = read_document(&downgraded, false).unwrap();
        assert_eq!(reparsed.document.version, DxfVersion::AC1015);
    }

    #[test]
    fn summary_reports_counts_layers_and_types() {
        let doc = sample_document();
        let json = summarize(&doc, false, 0, false);
        assert!(json.contains("\"entityCount\":4"), "{json}");
        assert!(json.contains("\"version\":\"AC1032\""), "{json}");
        assert!(json.contains("\"layerCount\":2"), "{json}");
        assert!(json.contains("\"WALLS\""), "{json}");
        assert!(json.contains("\"LINE\":1"), "{json}");
        assert!(json.contains("\"format\":\"dxf\""), "{json}");
        assert!(json.contains("\"recovered\":false"), "{json}");
    }

    #[test]
    fn summary_escapes_hostile_layer_names() {
        let mut doc = CadDocument::with_version(DxfVersion::AC1032);
        doc.layers
            .add(Layer::new("quote\" backslash\\ newline\n"))
            .unwrap();
        let json = summarize(&doc, false, 3, true);
        // The raw newline must not survive into the JSON payload.
        assert!(!json.contains('\n'), "{json}");
        assert!(json.contains("\\\\"), "{json}");
        assert!(json.contains("\"diagnostics\":3"), "{json}");
        assert!(json.contains("\"recovered\":true"), "{json}");
    }
}
