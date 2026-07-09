-- Web search: cached provider results (avoid duplicate paid queries) + request logs.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS web_search_cache (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash  text NOT NULL UNIQUE,
  query       text NOT NULL,
  provider    text NOT NULL,
  results     jsonb NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now(),
  expires_at  timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS web_search_cache_hash_idx ON web_search_cache(query_hash);

CREATE TABLE IF NOT EXISTS web_search_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query            text NOT NULL,
  provider         text NOT NULL,
  latency_ms       integer,
  results_returned integer,
  cache_hit        boolean NOT NULL DEFAULT false,
  error            text,
  created_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_search_logs_created_idx ON web_search_logs(created_at);
