//! Generates the fixture drawings used by the TypeScript integration tests and
//! by the app's demo data.
//!
//!     cargo run --example gen_fixture -- <output-dir>
//!
//! Writes `sample.dxf` and `sample.dwg` from the same in-memory document, so the
//! round-trip test can assert that DWG and DXF representations agree.

use acadrust::types::{Vector2, Vector3};
use acadrust::{
    CadDocument, Circle, DwgWriter, DxfVersion, DxfWriter, EntityType, Layer, Line, LwPolyline,
    Text,
};
use std::path::{Path, PathBuf};

fn build_document() -> CadDocument {
    let mut doc = CadDocument::with_version(DxfVersion::AC1032);

    for name in ["WALLS", "DIMS", "TEXT"] {
        doc.layers.add(Layer::new(name)).expect("unique layer name");
    }

    // A closed rectangle-ish outline.
    doc.add_entity(EntityType::LwPolyline(LwPolyline::from_points(vec![
        Vector2::new(0.0, 0.0),
        Vector2::new(200.0, 0.0),
        Vector2::new(200.0, 120.0),
        Vector2::new(0.0, 120.0),
    ])))
    .expect("add lwpolyline");

    // Internal partitions.
    doc.add_entity(EntityType::Line(Line::from_coords(
        100.0, 0.0, 0.0, 100.0, 120.0, 0.0,
    )))
    .expect("add line");
    doc.add_entity(EntityType::Line(Line::from_coords(
        100.0, 60.0, 0.0, 200.0, 60.0, 0.0,
    )))
    .expect("add line");

    // A few circles and arcs worth opening in the viewer.
    for index in 0..4 {
        let offset = index as f64 * 40.0;
        doc.add_entity(EntityType::Circle(Circle::from_center_radius(
            Vector3::new(30.0 + offset, 90.0, 0.0),
            12.0,
        )))
        .expect("add circle");
    }

    doc.add_entity(EntityType::Text(Text::with_value(
        "ACADRUSTR WASM",
        Vector3::new(20.0, 20.0, 0.0),
    )))
    .expect("add text");

    doc
}

fn main() {
    let out_dir: PathBuf = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "fixtures".to_string())
        .into();
    if let Err(error) = std::fs::create_dir_all(&out_dir) {
        eprintln!("cannot create {}: {error}", out_dir.display());
        std::process::exit(1);
    }

    let doc = build_document();
    let entities = doc.entity_count();
    let layers = doc.layers.len();

    let dxf_path = out_dir.join("sample.dxf");
    let dwg_path = out_dir.join("sample.dwg");

    match DxfWriter::new(&doc).write_to_vec() {
        Ok(bytes) => write(&dxf_path, &bytes),
        Err(error) => {
            eprintln!("DXF serialization failed: {error}");
            std::process::exit(1);
        }
    }

    match DwgWriter::write_to_vec(&doc) {
        Ok(bytes) => write(&dwg_path, &bytes),
        Err(error) => {
            eprintln!("DWG serialization failed: {error}");
            std::process::exit(1);
        }
    }

    println!(
        "wrote {} and {} ({entities} entities, {layers} layers)",
        dxf_path.display(),
        dwg_path.display()
    );
}

fn write(path: &Path, bytes: &[u8]) {
    if let Err(error) = std::fs::write(path, bytes) {
        eprintln!("cannot write {}: {error}", path.display());
        std::process::exit(1);
    }
    println!("  {} — {} bytes", path.display(), bytes.len());
}
