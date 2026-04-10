-- ============================================================
-- Laurens OS — Migration 003
-- Chantiers Phase A+B : relances, feedback loop, contacts, calendar invites
-- Date: 2026-04-10
-- ============================================================

-- ============================================================
-- relances_pending  (Chantier #2)
-- Emails envoyés sans réponse détectés par relance-detector
-- ============================================================
CREATE TABLE IF NOT EXISTS relances_pending (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       text NOT NULL UNIQUE,
  last_message_id text,
  recipient       text NOT NULL,
  subject         text,
  sent_at         timestamptz NOT NULL,
  days_since_sent int NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  dismissed       boolean NOT NULL DEFAULT false,
  dismissed_at    timestamptz,
  relance_sent    boolean NOT NULL DEFAULT false,
  relance_sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS relances_pending_dismissed_idx
  ON relances_pending (dismissed) WHERE dismissed = false;

CREATE INDEX IF NOT EXISTS relances_pending_thread_id_idx
  ON relances_pending (thread_id);

ALTER TABLE relances_pending ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- email_draft_corrections  (Chantier #4)
-- Corrections apportées par Laurent aux drafts générés
-- Note : table séparée de corrections_log (schéma différent)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_draft_corrections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_processed_id  uuid REFERENCES emails_processed(id),
  thread_id           text NOT NULL,
  draft_text          text NOT NULL,
  sent_text           text NOT NULL,
  similarity_score    numeric,
  diff_summary        text,
  patterns_detected   jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_draft_corrections_thread_id_idx
  ON email_draft_corrections (thread_id);

CREATE INDEX IF NOT EXISTS email_draft_corrections_created_at_idx
  ON email_draft_corrections (created_at DESC);

ALTER TABLE email_draft_corrections ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- style_dna_patterns  (Chantier #4)
-- Patterns stylistiques agrégés appris sur la durée
-- ============================================================
CREATE TABLE IF NOT EXISTS style_dna_patterns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type         text NOT NULL,  -- 'opening'|'closing'|'tone'|'length'|'formality'|'content'
  pattern_description  text NOT NULL,
  examples             jsonb,
  occurrence_count     int NOT NULL DEFAULT 1,
  first_seen           timestamptz NOT NULL DEFAULT now(),
  last_seen            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_dna_patterns_type_idx
  ON style_dna_patterns (pattern_type);

CREATE INDEX IF NOT EXISTS style_dna_patterns_occurrence_idx
  ON style_dna_patterns (occurrence_count DESC);

ALTER TABLE style_dna_patterns ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- contact_relationships  (Chantier #5 — préparation)
-- Relations contacts classifiées via LLM
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_relationships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address        text NOT NULL UNIQUE,
  display_name         text,
  relationship_type    text NOT NULL,
  -- 'coaching_individual'|'recurring_client'|'prospect'|'vendor'|'internal_team'|'admin'|'one_shot'
  organization         text,
  suggested_labels     jsonb,
  confidence           numeric,
  thread_count         int NOT NULL DEFAULT 0,
  last_interaction_at  timestamptz,
  reasoning            text,
  validated_by_human   boolean NOT NULL DEFAULT false,
  validated_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_relationships_email_idx
  ON contact_relationships (email_address);

CREATE INDEX IF NOT EXISTS contact_relationships_type_idx
  ON contact_relationships (relationship_type);

CREATE INDEX IF NOT EXISTS contact_relationships_validated_idx
  ON contact_relationships (validated_by_human);

ALTER TABLE contact_relationships ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- match_identity_corpus améliorée  (Chantier #4)
-- Boost x1.2 pour les entrées gmail_sent_corrected
-- ============================================================
CREATE OR REPLACE FUNCTION match_identity_corpus(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 5,
  filter_source text DEFAULT null
)
RETURNS TABLE(id uuid, content text, source text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT
    ic.id,
    ic.content,
    ic.source,
    (1 - (ic.embedding <=> query_embedding)) *
      CASE WHEN ic.source = 'gmail_sent_corrected' THEN 1.2 ELSE 1.0 END
      AS similarity
  FROM identity_corpus ic
  WHERE
    (filter_source IS NULL OR ic.source = filter_source OR ic.source = 'gmail_sent_corrected')
    AND (1 - (ic.embedding <=> query_embedding)) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
