CREATE TABLE IF NOT EXISTS dialogmint_vault_snapshots (
  account_id text PRIMARY KEY,
  format_version integer NOT NULL CHECK (format_version = 1),
  schema_version integer NOT NULL CHECK (schema_version = 10),
  revision bigint NOT NULL CHECK (revision > 0),
  ciphertext jsonb NOT NULL,
  ciphertext_digest text NOT NULL CHECK (ciphertext_digest ~ '^[0-9a-f]{64}$'),
  encrypted_bytes integer NOT NULL CHECK (encrypted_bytes > 0 AND encrypted_bytes <= 10485760),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS dialogmint_vault_snapshots_expiry_idx
  ON dialogmint_vault_snapshots (expires_at);
