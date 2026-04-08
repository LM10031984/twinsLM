-- ============================================================
-- Laurens OS — Identity Core Schema
-- Migration 001 — Schéma complet
-- Date: 2026-04-08
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- identity_corpus
-- Tous les écrits de Laurens vectorisés pour style matching
-- ============================================================
CREATE TABLE IF NOT EXISTS identity_corpus (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,           -- 'gmail_sent' | 'github_commit' | 'claude_session' | 'drive_doc'
  content      text NOT NULL,
  embedding    vector(1536),
  metadata     jsonb DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_corpus_embedding_idx
  ON identity_corpus USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS identity_corpus_source_idx
  ON identity_corpus (source);

-- ============================================================
-- style_dna
-- Embeddings ADN de communication — base de génération dans la voix de Laurens
-- ============================================================
CREATE TABLE IF NOT EXISTS style_dna (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension    text NOT NULL,           -- ex: 'tone', 'formality', 'vocabulary', 'structure'
  embedding    vector(1536),
  sample_count int  NOT NULL DEFAULT 0,
  metadata     jsonb DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_dna_dimension_idx
  ON style_dna (dimension);

-- ============================================================
-- decisions_log
-- Chaque choix validé/corrigé + contexte pour apprentissage
-- ============================================================
CREATE TABLE IF NOT EXISTS decisions_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text NOT NULL,           -- 'InboxTwin' | 'AdminTwin' | 'CodeTwin' etc.
  context      text,
  decision     text NOT NULL,
  outcome      text,                    -- 'validated' | 'corrected' | 'rejected'
  metadata     jsonb DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decisions_log_agent_idx
  ON decisions_log (agent);

CREATE INDEX IF NOT EXISTS decisions_log_created_at_idx
  ON decisions_log (created_at DESC);

-- ============================================================
-- corrections_log
-- Modifications de drafts par Laurens — feedback loop direct
-- ============================================================
CREATE TABLE IF NOT EXISTS corrections_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     text NOT NULL,        -- 'email_draft' | 'linkedin_post' | 'code_review'
  original_draft  text NOT NULL,
  corrected_text  text NOT NULL,
  diff_summary    text,
  embedding       vector(1536),
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS corrections_log_source_type_idx
  ON corrections_log (source_type);

CREATE INDEX IF NOT EXISTS corrections_log_embedding_idx
  ON corrections_log USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- ============================================================
-- emails_processed
-- Emails traités + statut + draft généré — déduplication
-- ============================================================
CREATE TABLE IF NOT EXISTS emails_processed (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_id     text UNIQUE NOT NULL,
  thread_id    text,
  sender       text,
  subject      text,
  received_at  timestamptz,
  triage_label text,                    -- 'URGENT' | 'NEEDS_REPLY' | 'FYI' | 'JUNK'
  draft_id     text,                    -- Gmail draft ID si généré
  draft_text   text,
  embedding    vector(1536),
  status       text NOT NULL DEFAULT 'processed',
  metadata     jsonb DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS emails_processed_gmail_id_idx
  ON emails_processed (gmail_id);

CREATE INDEX IF NOT EXISTS emails_processed_triage_label_idx
  ON emails_processed (triage_label);

CREATE INDEX IF NOT EXISTS emails_processed_received_at_idx
  ON emails_processed (received_at DESC);

-- ============================================================
-- learners
-- Apprenants RTBL + statut parcours — LearnerAgent
-- ============================================================
CREATE TABLE IF NOT EXISTS learners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  email            text,
  program_id       uuid,
  enrollment_date  date,
  status           text NOT NULL DEFAULT 'active',  -- 'active' | 'completed' | 'dropped'
  funding_type     text,               -- 'CPF' | 'OPCO' | 'personal' | 'employer'
  notes            text,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learners_status_idx
  ON learners (status);

CREATE INDEX IF NOT EXISTS learners_program_id_idx
  ON learners (program_id);

-- ============================================================
-- programs
-- Programmes de formation + tarifs — AdminTwin + Prospects
-- ============================================================
CREATE TABLE IF NOT EXISTS programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  code            text UNIQUE,
  duration_hours  int,
  price_ht        numeric(10,2),
  certification   text,                -- 'Qualiopi' | 'RNCP' etc.
  active          boolean NOT NULL DEFAULT true,
  drive_folder_id text,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- drive_index
-- Index fichiers Drive + dernière ouverture — DriveWatcher
-- ============================================================
CREATE TABLE IF NOT EXISTS drive_index (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id   text UNIQUE NOT NULL,
  name            text NOT NULL,
  mime_type       text,
  last_opened_at  timestamptz,
  last_modified   timestamptz,
  summary         text,
  embedding       vector(1536),
  metadata        jsonb DEFAULT '{}',
  indexed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_index_last_opened_at_idx
  ON drive_index (last_opened_at DESC NULLS LAST);

-- ============================================================
-- conversations
-- Sessions Claude Code (via hooks ruflo) — contexte décisions
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text UNIQUE NOT NULL,
  summary      text,
  decisions    jsonb DEFAULT '[]',
  embedding    vector(1536),
  started_at   timestamptz,
  ended_at     timestamptz,
  metadata     jsonb DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_session_id_idx
  ON conversations (session_id);

CREATE INDEX IF NOT EXISTS conversations_ended_at_idx
  ON conversations (ended_at DESC NULLS LAST);

-- ============================================================
-- real_estate_clients
-- Conseillers + usage outils immobilier — ImmobilierTwin
-- ============================================================
CREATE TABLE IF NOT EXISTS real_estate_clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text,
  company       text,
  tools_used    text[] DEFAULT '{}',
  onboarded_at  timestamptz,
  last_active   timestamptz,
  status        text NOT NULL DEFAULT 'active',
  notes         text,
  metadata      jsonb DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_estate_clients_status_idx
  ON real_estate_clients (status);

-- ============================================================
-- agent_memory
-- Mémoire persistante par agent — continuité entre sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_memory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text NOT NULL,
  key          text NOT NULL,
  value        text,
  embedding    vector(1536),
  expires_at   timestamptz,
  metadata     jsonb DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, key)
);

CREATE INDEX IF NOT EXISTS agent_memory_agent_key_idx
  ON agent_memory (agent, key);

CREATE INDEX IF NOT EXISTS agent_memory_expires_at_idx
  ON agent_memory (expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================
-- Row Level Security — activé par défaut, service role bypass
-- ============================================================
ALTER TABLE identity_corpus        ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_dna              ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails_processed       ENABLE ROW LEVEL SECURITY;
ALTER TABLE learners               ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_index            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE real_estate_clients    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory           ENABLE ROW LEVEL SECURITY;
