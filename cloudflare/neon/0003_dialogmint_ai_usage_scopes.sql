CREATE TABLE IF NOT EXISTS dialogmint_ai_usage_scopes (
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('anthropic', 'workers_ai')),
  environment text NOT NULL CHECK (environment IN ('testing', 'production')),
  last_used_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, provider, environment)
);

CREATE INDEX IF NOT EXISTS dialogmint_ai_usage_scopes_expiry
  ON dialogmint_ai_usage_scopes (environment, last_used_at);
