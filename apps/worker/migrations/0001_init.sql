-- Drawing index for onlinecad.
--
-- Reminder: no column here holds drawing content. The browser parses and edits
-- locally; this table is a register of derived metadata (the equivalent of the
-- sheet index at the front of a drawing set).

CREATE TABLE IF NOT EXISTS drawings (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  format        TEXT    NOT NULL CHECK (format IN ('dwg', 'dxf')),
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 of the local file, computed in the browser. Lets a re-save update
  -- the existing entry instead of creating a duplicate.
  content_hash  TEXT,
  -- Source CAD version code, e.g. 'AC1032'.
  cad_version   TEXT,
  entity_count  INTEGER NOT NULL DEFAULT 0,
  layer_count   INTEGER NOT NULL DEFAULT 0,
  -- JSON array of layer names. Denormalised on purpose so listing drawings is a
  -- single query; `drawing_layers` below is the indexed, filterable copy. Both
  -- are written together, so they cannot drift.
  layer_names   TEXT,
  -- JSON object of entity-type -> count, e.g. {"LINE":42}.
  entity_types  TEXT,
  notes         TEXT,
  tags          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- Lookup by fingerprint when re-saving, and by recency for the default listing.
CREATE INDEX IF NOT EXISTS idx_drawings_content_hash ON drawings (content_hash);
CREATE INDEX IF NOT EXISTS idx_drawings_updated_at   ON drawings (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drawings_name         ON drawings (name);

-- Normalised layer membership, so "which drawings use layer X?" is an indexed
-- lookup rather than a JSON scan, and so layer statistics are cheap.
CREATE TABLE IF NOT EXISTS drawing_layers (
  drawing_id TEXT NOT NULL,
  layer_name TEXT NOT NULL,
  PRIMARY KEY (drawing_id, layer_name),
  FOREIGN KEY (drawing_id) REFERENCES drawings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_drawing_layers_layer ON drawing_layers (layer_name);
