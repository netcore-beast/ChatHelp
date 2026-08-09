CREATE TABLE IF NOT EXISTS dialogmint_learning_preferences (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  notice_version text NOT NULL DEFAULT '2026-08-09-v1',
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days = 365),
  auto_enabled_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS dialogmint_learning_records (
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f]{64}$'),
  record_id varchar(64) NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('classifier', 'evaluation', 'generative')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  role_id varchar(64) NOT NULL CHECK (role_id IN (
    'human_resource', 'network_marketing', 'job_seeker', 'socializing_networking'
  )),
  relationship_stage text NOT NULL CHECK (relationship_stage IN (
    'new_connection', 'genuine_rapport', 'learn_interests', 'identify_need',
    'ask_permission', 'introduce_value', 'answer_without_pressure', 'voluntary_next_step'
  )),
  goal_category text NOT NULL CHECK (goal_category IN (
    'connect', 'build_rapport', 'discover_interests', 'identify_need',
    'request_permission', 'present_value', 'answer_questions', 'agree_next_step'
  )),
  classifier_features jsonb,
  evaluation_action text CHECK (evaluation_action IN ('useful', 'not_useful', 'accepted', 'edited', 'rejected')),
  target_text text CHECK (target_text IS NULL OR (length(target_text) BETWEEN 1 AND 2000)),
  provenance text NOT NULL CHECK (provenance IN ('human_confirmed', 'independently_user_authored')),
  rights_attested_at timestamptz,
  privacy_attested_at timestamptz,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, record_id),
  UNIQUE (account_id, content_digest),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days'),
  CHECK (
    record_kind <> 'classifier' OR (
      classifier_features IS NOT NULL
      AND jsonb_typeof(classifier_features) = 'object'
      AND classifier_features ?& ARRAY[
        'messageCountBucket', 'hasIncomingQuestion', 'hasNeedSignal',
        'hasPermissionSignal', 'hasValueDiscussionSignal', 'hasNextStepSignal'
      ]
      AND classifier_features - ARRAY[
        'messageCountBucket', 'hasIncomingQuestion', 'hasNeedSignal',
        'hasPermissionSignal', 'hasValueDiscussionSignal', 'hasNextStepSignal'
      ] = '{}'::jsonb
      AND classifier_features->>'messageCountBucket' IN ('unknown', 'low', 'medium', 'high')
      AND jsonb_typeof(classifier_features->'hasIncomingQuestion') = 'boolean'
      AND jsonb_typeof(classifier_features->'hasNeedSignal') = 'boolean'
      AND jsonb_typeof(classifier_features->'hasPermissionSignal') = 'boolean'
      AND jsonb_typeof(classifier_features->'hasValueDiscussionSignal') = 'boolean'
      AND jsonb_typeof(classifier_features->'hasNextStepSignal') = 'boolean'
      AND evaluation_action IS NULL AND target_text IS NULL
      AND provenance = 'human_confirmed'
      AND rights_attested_at IS NULL AND privacy_attested_at IS NULL
    )
  ),
  CHECK (
    record_kind <> 'evaluation' OR (
      classifier_features IS NULL AND evaluation_action IS NOT NULL AND target_text IS NULL
      AND provenance = 'human_confirmed'
      AND rights_attested_at IS NULL AND privacy_attested_at IS NULL
    )
  ),
  CHECK (
    record_kind <> 'generative' OR (
      classifier_features IS NULL AND evaluation_action IS NULL AND target_text IS NOT NULL
      AND provenance = 'independently_user_authored'
      AND rights_attested_at IS NOT NULL AND privacy_attested_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS dialogmint_learning_records_account_lookup
  ON dialogmint_learning_records (account_id, enabled, relationship_stage, role_id, updated_at DESC, record_id);
CREATE INDEX IF NOT EXISTS dialogmint_learning_records_expiry
  ON dialogmint_learning_records (expires_at);

CREATE TABLE IF NOT EXISTS dialogmint_ai_usage_attempts (
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('anthropic', 'workers_ai')),
  model_id text NOT NULL,
  pipeline_stage text NOT NULL CHECK (pipeline_stage IN ('analyzing', 'drafting', 'reviewing')),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed-safe', 'timed-out', 'rate-limited', 'cancelled')),
  usage_quality text NOT NULL DEFAULT 'unavailable' CHECK (usage_quality IN ('exact', 'estimated', 'unavailable')),
  uncached_input_tokens bigint CHECK (uncached_input_tokens IS NULL OR uncached_input_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cache_write_5m_tokens bigint CHECK (cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0),
  cache_write_1h_tokens bigint CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0),
  cache_read_tokens bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  thinking_tokens bigint CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  prompt_tokens bigint CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_neurons bigint CHECK (estimated_neurons IS NULL OR estimated_neurons >= 0),
  estimated_cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_micro_usd >= 0),
  pricing_version text NOT NULL DEFAULT '2026-08-09-v1',
  pricing_effective_date date NOT NULL DEFAULT DATE '2026-08-09',
  estimator_version text,
  pricing_source text NOT NULL DEFAULT 'published-model' CHECK (pricing_source IN ('published-model', 'published-proxy')),
  environment text NOT NULL CHECK (environment IN ('testing', 'production')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (account_id, request_id, attempt_id),
  CHECK ((status = 'started' AND completed_at IS NULL) OR (status <> 'started' AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS dialogmint_ai_usage_account_month
  ON dialogmint_ai_usage_attempts (account_id, provider, started_at);
CREATE INDEX IF NOT EXISTS dialogmint_ai_usage_expiry
  ON dialogmint_ai_usage_attempts (environment, started_at);

CREATE TABLE IF NOT EXISTS dialogmint_ai_allowances (
  account_id text NOT NULL CHECK (account_id ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('anthropic', 'workers_ai')),
  monthly_allowance_micro_usd bigint NOT NULL CHECK (monthly_allowance_micro_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);

CREATE OR REPLACE FUNCTION dialogmint_enforce_usage_attempt_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.account_id <> NEW.account_id
     OR OLD.request_id <> NEW.request_id
     OR OLD.attempt_id <> NEW.attempt_id
     OR OLD.provider <> NEW.provider
     OR OLD.model_id <> NEW.model_id
     OR OLD.pipeline_stage <> NEW.pipeline_stage
     OR OLD.environment <> NEW.environment
     OR OLD.started_at <> NEW.started_at THEN
    RAISE EXCEPTION 'usage_attempt_identity_is_immutable';
  END IF;
  IF OLD.status = 'started' AND NEW.status <> 'started' THEN
    RETURN NEW;
  END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid_usage_attempt_transition';
END;
$$;

DROP TRIGGER IF EXISTS dialogmint_usage_attempt_transition ON dialogmint_ai_usage_attempts;
CREATE TRIGGER dialogmint_usage_attempt_transition
BEFORE UPDATE ON dialogmint_ai_usage_attempts
FOR EACH ROW EXECUTE FUNCTION dialogmint_enforce_usage_attempt_transition();
