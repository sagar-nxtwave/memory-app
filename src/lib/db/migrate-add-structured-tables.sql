-- Structured tabular storage: enables SQL-answerable count / list / aggregate queries
-- over full spreadsheet/CSV columns, which top-K vector RAG can never do.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS document_tables (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sheet_name   text NOT NULL,
  headers      jsonb NOT NULL,
  row_count    integer NOT NULL DEFAULT 0,
  column_stats jsonb,
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_tables_document_idx ON document_tables(document_id);
CREATE INDEX IF NOT EXISTS document_tables_space_idx    ON document_tables(space_id);

CREATE TABLE IF NOT EXISTS document_rows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id     uuid NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id     uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  row_index    integer NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_rows_table_idx ON document_rows(table_id);
CREATE INDEX IF NOT EXISTS document_rows_space_idx ON document_rows(space_id);
