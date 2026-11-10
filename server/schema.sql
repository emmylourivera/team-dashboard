-- Team Dashboard v3 schema. Safe to run more than once.

-- Every record the dashboard saves is a JSON document at a path such as
-- "requests/abc123" or "requests/abc123/chat/m1". "parent" is the collection
-- the document lives in ("requests", "requests/abc123/chat").
CREATE TABLE IF NOT EXISTS docs (
  path        text PRIMARY KEY,
  parent      text NOT NULL,
  id          text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS docs_parent_idx ON docs (parent);

-- Uploaded files (artwork, dielines, PDFs, product images).
CREATE TABLE IF NOT EXISTS blobs (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  data          bytea NOT NULL,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Everyone who has signed in. Used for names, avatars and the people search.
CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,   -- lower-case email address
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  avatar      text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
