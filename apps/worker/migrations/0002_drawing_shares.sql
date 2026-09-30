-- Share links for drawings whose original file the user explicitly chose to
-- publish.
--
-- Until now the server never held drawing *content*: the browser parsed and
-- edited locally and only derived metadata travelled to D1. Sharing is a
-- deliberate, per-drawing opt-in — the browser uploads the original bytes and
-- the Worker stores them in R2 under the object key `shares/<token>`, while the
-- index below records that a link exists and when it stops working.
--
-- The columns live on `drawings` rather than a join table because a drawing has
-- at most one active link: regenerating writes a new token, revoking clears
-- these columns. Presence of `share_token` is the single source of truth for
-- "the original file is on the server".

ALTER TABLE drawings ADD COLUMN share_token       TEXT;
ALTER TABLE drawings ADD COLUMN share_file_name   TEXT;
ALTER TABLE drawings ADD COLUMN share_size_bytes  INTEGER;
ALTER TABLE drawings ADD COLUMN share_created_at  TEXT;
-- NULL means the link never expires.
ALTER TABLE drawings ADD COLUMN share_expires_at  TEXT;

-- The token is the secret in the URL, so lookups are exact and unique.
-- SQLite allows several NULLs in a unique index, which is what lets unshared
-- drawings coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawings_share_token ON drawings (share_token);
