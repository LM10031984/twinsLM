# Laurens OS — Phase 1 : Identity Core + InboxTwin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Déployer le cerveau Supabase complet (pgvector + observabilité dès le départ) + InboxTwin horaire opérationnel avec filtre identitaire + Discord basique + briefing matin.

**Architecture:** Supabase (PostgreSQL + pgvector) stocke tout. Les agents tournent comme Supabase Edge Functions (Deno/TypeScript) déclenchées par pg_cron — aucune dépendance à Claude Code pour l'exécution continue. Gmail et Drive sont appelés via leurs APIs REST directement depuis les Edge Functions, avec le OAuth refresh token stocké dans les Supabase Secrets. Discord reçoit les notifications via webhook entrant. Ruflo augmente la mémoire sémantique via agentdb.

**Tech Stack:** Supabase MCP (PostgreSQL 15 + pgvector + pg_cron + Edge Functions Deno 1.x), Gmail API v1, Google Drive API v3, Discord Incoming Webhook, ruflo agentdb + embeddings.

**Ordre de build (ingénierie):**
1. Schéma complet avec observabilité (decisions_log, corrections_log) — même si un seul agent tourne
2. InboxTwin en premier — valide le filtre identitaire avant de câbler les autres agents
3. AdminTwin Qualiopi en dernier (Plan 3) — impact réglementaire, erreur silencieuse coûteuse

---

## Fichiers créés / modifiés

| Fichier | Rôle |
|---|---|
| `supabase/migrations/001_schema.sql` | Schéma complet toutes tables + pgvector + observabilité |
| `supabase/migrations/002_pgcron.sql` | Scheduling InboxTwin + briefing matin |
| `supabase/functions/inbox-twin/index.ts` | Agent InboxTwin (scan + triage + draft) |
| `supabase/functions/inbox-twin/gmail.ts` | Client Gmail API |
| `supabase/functions/inbox-twin/identity.ts` | Filtre identitaire (semantic search pgvector) |
| `supabase/functions/inbox-twin/logger.ts` | Logging decisions_log + corrections_log |
| `supabase/functions/morning-briefing/index.ts` | Briefing quotidien 8h |
| `supabase/functions/ingest-style-dna/index.ts` | Ingestion 500 emails envoyés → pgvector |
| `supabase/functions/discord-notify/index.ts` | Notification Discord webhook |
| `scripts/setup-oauth.md` | Guide setup Google OAuth (one-time, navigateur) |
| `scripts/test-inboxtwin.ts` | Tests d'intégration manuels |

---

## Task 1 : Supabase projet + pgvector + schéma complet

**But :** Créer le projet Supabase et tous les tables — incluant decisions_log et corrections_log dès le départ.

**Files:**
- Create: `supabase/migrations/001_schema.sql`

- [ ] **Step 1.1 : Créer le projet Supabase**

Via le Supabase MCP :
```
mcp__claude_ai_Supabase__create_project avec :
  name: "laurens-os"
  region: "eu-west-2"  (London — plus proche de la France)
  plan: "free"
```

Sauvegarder le `project_id` retourné — utilisé dans tous les steps suivants.

- [ ] **Step 1.2 : Activer pgvector**

```sql
-- Via mcp__claude_ai_Supabase__apply_migration
create extension if not exists vector;
create extension if not exists pg_cron;
create extension if not exists pg_net;  -- pour les HTTP calls depuis SQL
```

Vérifier :
```sql
select * from pg_extension where extname in ('vector','pg_cron','pg_net');
-- Doit retourner 3 lignes
```

- [ ] **Step 1.3 : Créer toutes les tables**

Créer `supabase/migrations/001_schema.sql` :

```sql
-- ============================================================
-- IDENTITY CORE — toutes les tables Laurens OS
-- ============================================================

-- Corpus vectorisé de tout ce qu'a écrit Laurens
create table identity_corpus (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,  -- 'gmail_sent' | 'drive_doc' | 'github_commit' | 'claude_session'
  source_id    text,           -- id externe (message-id Gmail, file_id Drive, sha commit)
  content      text not null,
  embedding    vector(1536),   -- OpenAI ada-002 compatible, ruflo embeddings
  metadata     jsonb default '{}',
  created_at   timestamptz default now()
);
create index on identity_corpus using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on identity_corpus (source);

-- ADN de style de communication
create table style_dna (
  id           uuid primary key default gen_random_uuid(),
  dimension    text not null,  -- 'email_tone' | 'email_opening' | 'email_closing' | 'code_style' | 'vocabulary'
  exemplar     text not null,  -- exemple représentatif
  embedding    vector(1536),
  weight       float default 1.0,
  updated_at   timestamptz default now()
);
create index on style_dna using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- ============================================================
-- OBSERVABILITÉ — posée dès le premier agent
-- ============================================================

-- Log de chaque décision prise par un agent
create table decisions_log (
  id             uuid primary key default gen_random_uuid(),
  agent          text not null,     -- 'inbox_twin' | 'code_twin' | etc.
  action         text not null,     -- 'triage' | 'draft_generated' | 'label_applied'
  input_summary  text,
  output_summary text,
  confidence     float,             -- 0-1, confiance du filtre identitaire
  metadata       jsonb default '{}',
  created_at     timestamptz default now()
);
create index on decisions_log (agent, created_at desc);

-- Log des corrections que Laurens apporte aux drafts
-- C'est ici que le jumeau apprend
create table corrections_log (
  id              uuid primary key default gen_random_uuid(),
  decision_id     uuid references decisions_log(id),
  agent           text not null,
  original_draft  text not null,
  corrected_text  text not null,
  diff_summary    text,             -- résumé humain de ce qui a changé
  learned         bool default false,  -- true quand embedding re-calculé
  created_at      timestamptz default now()
);
create index on corrections_log (agent, learned, created_at desc);

-- ============================================================
-- INBOX TWIN
-- ============================================================

create table emails_processed (
  id              uuid primary key default gen_random_uuid(),
  gmail_message_id text unique not null,
  thread_id       text,
  subject         text,
  sender          text,
  received_at     timestamptz,
  triage_category text check (triage_category in ('URGENT','NEEDS_REPLY','FYI','JUNK')),
  triage_reason   text,
  labels_applied  text[],
  draft_id        text,             -- id du brouillon Gmail créé
  draft_text      text,
  style_confidence float,           -- qualité du filtre identitaire 0-1
  processed_at    timestamptz default now(),
  decision_log_id uuid references decisions_log(id)
);
create index on emails_processed (triage_category, processed_at desc);
create index on emails_processed (gmail_message_id);

-- ============================================================
-- AGENTS — mémoire partagée
-- ============================================================

create table agent_memory (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,
  key         text not null,
  value       jsonb,
  embedding   vector(1536),
  updated_at  timestamptz default now(),
  unique (agent, key)
);
create index on agent_memory (agent, key);

-- ============================================================
-- FORMATION (Start Academy)
-- ============================================================

create table learners (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  email            text unique,
  phone            text,
  program          text,
  status           text,           -- 'en_cours' | 'termine' | 'abandonne' | 'inscrit'
  start_date       date,
  end_date         date,
  opco             text,
  funding_status   text,
  drive_folder_id  text,
  metadata         jsonb default '{}',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table programs (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  duration_h   int,
  price_ht     numeric(10,2),
  objectives   text[],
  drive_file_id text,
  active       bool default true,
  created_at   timestamptz default now()
);

-- ============================================================
-- DRIVE INDEX
-- ============================================================

create table drive_index (
  id             uuid primary key default gen_random_uuid(),
  file_id        text unique not null,
  name           text,
  mime_type      text,
  last_opened_at timestamptz,
  last_modified  timestamptz,
  summary        text,
  embedding      vector(1536),
  parent_folder  text,
  metadata       jsonb default '{}',
  indexed_at     timestamptz default now()
);
create index on drive_index (last_opened_at desc);

-- ============================================================
-- IMMOBILIER
-- ============================================================

create table real_estate_clients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text unique,
  type          text check (type in ('conseiller', 'futur_client')),
  tool_id       text,
  onboarded_at  timestamptz,
  last_active   timestamptz,
  metadata      jsonb default '{}',
  created_at    timestamptz default now()
);

-- ============================================================
-- CONVERSATIONS (sessions Claude Code)
-- ============================================================

create table conversations (
  id          uuid primary key default gen_random_uuid(),
  session_id  text,
  role        text check (role in ('user', 'assistant')),
  content     text,
  embedding   vector(1536),
  created_at  timestamptz default now()
);
create index on conversations using ivfflat (embedding vector_cosine_ops) with (lists = 50);
create index on conversations (session_id, created_at);
```

- [ ] **Step 1.4 : Appliquer la migration**

```
mcp__claude_ai_Supabase__apply_migration(
  project_id: "<project_id>",
  name: "001_schema",
  query: <contenu du fichier 001_schema.sql>
)
```

- [ ] **Step 1.5 : Vérifier le schéma**

```sql
select table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

Attendu : 12 tables listées (identity_corpus, style_dna, decisions_log, corrections_log, emails_processed, agent_memory, learners, programs, drive_index, real_estate_clients, conversations, + pg_cron system tables).

- [ ] **Step 1.6 : Commit**

```bash
git add supabase/migrations/001_schema.sql
git commit -m "feat(supabase): full schema with pgvector + observability tables from day 1"
```

---

## Task 2 : Google OAuth setup (one-time)

**But :** Obtenir un refresh token Google pour Gmail + Drive, stocké dans Supabase Secrets. Les Edge Functions l'utilisent pour appeler les APIs directement, sans dépendre d'une session Claude Code.

**Files:**
- Create: `scripts/setup-oauth.md`

- [ ] **Step 2.1 : Créer le projet Google Cloud**

Aller sur https://console.cloud.google.com → Nouveau projet → Nom : `laurens-os`

- [ ] **Step 2.2 : Activer les APIs**

Dans APIs & Services → Enable APIs :
- Gmail API
- Google Drive API

- [ ] **Step 2.3 : Créer les credentials OAuth2**

APIs & Services → Credentials → Create Credentials → OAuth client ID
- Application type : **Web application**
- Authorized redirect URIs : `https://<project_ref>.supabase.co/functions/v1/oauth-callback`

Sauvegarder `client_id` et `client_secret`.

- [ ] **Step 2.4 : Générer le refresh token**

Construire l'URL d'autorisation :
```
https://accounts.google.com/o/oauth2/v2/auth?
  client_id=<CLIENT_ID>&
  redirect_uri=https://<project_ref>.supabase.co/functions/v1/oauth-callback&
  response_type=code&
  scope=https://www.googleapis.com/auth/gmail.readonly
        https://www.googleapis.com/auth/gmail.compose
        https://www.googleapis.com/auth/drive.readonly&
  access_type=offline&
  prompt=consent
```

Ouvrir dans le navigateur → autoriser → récupérer le `code` dans l'URL de redirection.

Échanger le code contre tokens :
```bash
curl -X POST https://oauth2.googleapis.com/token \
  -d "code=<CODE>&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>&redirect_uri=<REDIRECT>&grant_type=authorization_code"
```

Sauvegarder le `refresh_token` retourné.

- [ ] **Step 2.5 : Stocker dans Supabase Secrets**

```
mcp__claude_ai_Supabase__apply_migration avec :
-- via Supabase Dashboard → Settings → Edge Functions → Secrets
GOOGLE_CLIENT_ID=<client_id>
GOOGLE_CLIENT_SECRET=<client_secret>
GOOGLE_REFRESH_TOKEN=<refresh_token>
DISCORD_WEBHOOK_URL=<webhook_discord_privé>
```

- [ ] **Step 2.6 : Tester l'accès Gmail**

```typescript
// test rapide via mcp__claude_ai_Supabase__execute_sql
// Vérifier que le secret est lisible depuis une Edge Function test
```

Appeler Gmail API avec le refresh token :
```bash
# Obtenir un access token
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&refresh_token=$GOOGLE_REFRESH_TOKEN&grant_type=refresh_token" \
  | jq -r '.access_token')

# Lister les derniers messages envoyés
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=5" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.messages | length'
# Attendu : 5
```

- [ ] **Step 2.7 : Commit**

```bash
git add scripts/setup-oauth.md
git commit -m "docs: Google OAuth setup guide for Gmail + Drive access"
```

---

## Task 3 : Ingestion Style DNA (500 emails envoyés → pgvector)

**But :** Vectoriser les 500 derniers emails que Laurens a envoyés et les stocker dans `identity_corpus` + calculer le `style_dna`. C'est le fondement du filtre identitaire.

**Files:**
- Create: `supabase/functions/ingest-style-dna/index.ts`

- [ ] **Step 3.1 : Écrire la fonction d'ingestion**

Créer `supabase/functions/ingest-style-dna/index.ts` :

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getGoogleAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function fetchSentEmails(accessToken: string, maxResults = 500) {
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listResp.json();
  if (!list.messages) return [];

  const emails = [];
  for (const msg of list.messages) {
    const msgResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const full = await msgResp.json();
    const headers = full.payload?.headers || [];
    const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
    const to = headers.find((h: any) => h.name === "To")?.value || "";
    const body = extractBody(full.payload);
    if (body.length > 50) {  // ignorer les emails trop courts
      emails.push({ id: msg.id, subject, to, body, date: full.internalDate });
    }
  }
  return emails;
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}

async function vectorize(text: string): Promise<number[]> {
  // Utilise l'API OpenAI-compatible via Supabase AI ou ruflo embeddings
  // Ici on utilise le modèle d'embeddings local de Supabase (gte-small, 384 dims)
  // Si ruflo embeddings disponibles, adapter
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ input: text.slice(0, 2000) }),
  });
  const data = await resp.json();
  return data.embedding;
}

serve(async (req) => {
  try {
    const accessToken = await getGoogleAccessToken();
    const emails = await fetchSentEmails(accessToken, 500);

    let ingested = 0;
    for (const email of emails) {
      const content = `Sujet: ${email.subject}\nDestinataire: ${email.to}\n\n${email.body}`;
      const embedding = await vectorize(content);

      const { error } = await supabase.from("identity_corpus").upsert({
        source: "gmail_sent",
        source_id: email.id,
        content,
        embedding,
        metadata: { subject: email.subject, to: email.to, date: email.date },
      }, { onConflict: "source_id" });

      if (!error) ingested++;
    }

    // Calculer style_dna depuis les emails ingérés
    await computeStyleDna();

    // Log dans decisions_log
    await supabase.from("decisions_log").insert({
      agent: "ingest_style_dna",
      action: "initial_ingestion",
      input_summary: `${emails.length} emails envoyés`,
      output_summary: `${ingested} emails vectorisés dans identity_corpus`,
      confidence: 1.0,
      metadata: { total_fetched: emails.length, total_ingested: ingested },
    });

    return new Response(JSON.stringify({ ingested, total: emails.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});

async function computeStyleDna() {
  // Récupère les 50 emails les plus récents pour calculer les patterns de style
  const { data: recent } = await supabase
    .from("identity_corpus")
    .select("content, embedding")
    .eq("source", "gmail_sent")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!recent?.length) return;

  // Calcule l'embedding moyen = centroïde du style
  const dims = recent[0].embedding.length;
  const centroid = new Array(dims).fill(0);
  for (const row of recent) {
    for (let i = 0; i < dims; i++) centroid[i] += row.embedding[i] / recent.length;
  }

  await supabase.from("style_dna").upsert({
    dimension: "email_centroid",
    exemplar: recent[0].content.slice(0, 500),
    embedding: centroid,
    weight: 1.0,
  }, { onConflict: "dimension" });
}
```

- [ ] **Step 3.2 : Déployer la Edge Function**

```
mcp__claude_ai_Supabase__deploy_edge_function(
  project_id: "<project_id>",
  name: "ingest-style-dna",
  entrypoint_path: "supabase/functions/ingest-style-dna/index.ts"
)
```

- [ ] **Step 3.3 : Déclencher l'ingestion**

```bash
curl -X POST https://<project_ref>.supabase.co/functions/v1/ingest-style-dna \
  -H "Authorization: Bearer <anon_key>"
```

Attendu :
```json
{"ingested": 487, "total": 500}
```

- [ ] **Step 3.4 : Vérifier dans Supabase**

```sql
select source, count(*), min(created_at), max(created_at)
from identity_corpus
group by source;
-- Attendu : gmail_sent | ~487 | ...

select dimension, weight, updated_at from style_dna;
-- Attendu : email_centroid | 1.0 | now()
```

- [ ] **Step 3.5 : Commit**

```bash
git add supabase/functions/ingest-style-dna/
git commit -m "feat(ingest): vectorize 500 sent Gmail emails into identity_corpus + compute style_dna centroid"
```

---

## Task 4 : InboxTwin — Scanner + Triage

**But :** Edge Function qui scanne Gmail toutes les heures, trie les emails en URGENT/NEEDS_REPLY/FYI/JUNK, log chaque décision.

**Files:**
- Create: `supabase/functions/inbox-twin/gmail.ts`
- Create: `supabase/functions/inbox-twin/logger.ts`
- Create: `supabase/functions/inbox-twin/index.ts` (partiel — triage seulement)

- [ ] **Step 4.1 : Écrire le client Gmail**

Créer `supabase/functions/inbox-twin/gmail.ts` :

```typescript
export async function getGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`OAuth refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: Date;
  labelIds: string[];
}

export async function fetchNewEmails(
  accessToken: string,
  afterTimestamp: Date
): Promise<GmailMessage[]> {
  const after = Math.floor(afterTimestamp.getTime() / 1000);
  const query = `in:inbox after:${after} -from:me`;

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listResp.json();
  if (!list.messages?.length) return [];

  const messages: GmailMessage[] = [];
  for (const msg of list.messages) {
    const full = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then(r => r.json());

    const headers = full.payload?.headers || [];
    const get = (name: string) => headers.find((h: any) => h.name === name)?.value || "";

    messages.push({
      id: msg.id,
      threadId: full.threadId,
      subject: get("Subject"),
      sender: get("From"),
      body: extractBody(full.payload),
      receivedAt: new Date(parseInt(full.internalDate)),
      labelIds: full.labelIds || [],
    });
  }
  return messages;
}

export async function createDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<string> {
  const message = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: { raw: encoded, ...(threadId ? { threadId } : {}) },
    }),
  });
  const data = await resp.json();
  return data.id;
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    try { return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/")); }
    catch { return ""; }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}
```

- [ ] **Step 4.2 : Écrire le logger (observabilité)**

Créer `supabase/functions/inbox-twin/logger.ts` :

```typescript
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function logDecision(
  supabase: SupabaseClient,
  params: {
    agent: string;
    action: string;
    inputSummary: string;
    outputSummary: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("decisions_log")
    .insert({
      agent: params.agent,
      action: params.action,
      input_summary: params.inputSummary,
      output_summary: params.outputSummary,
      confidence: params.confidence,
      metadata: params.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) console.error("decisions_log insert failed:", error);
  return data?.id ?? "";
}

export async function logCorrection(
  supabase: SupabaseClient,
  params: {
    decisionId: string;
    agent: string;
    originalDraft: string;
    correctedText: string;
    diffSummary?: string;
  }
): Promise<void> {
  await supabase.from("corrections_log").insert({
    decision_id: params.decisionId,
    agent: params.agent,
    original_draft: params.originalDraft,
    corrected_text: params.correctedText,
    diff_summary: params.diffSummary ?? "",
    learned: false,
  });
}
```

- [ ] **Step 4.3 : Écrire la logique de triage**

Ajouter dans `supabase/functions/inbox-twin/index.ts` :

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken, fetchNewEmails, createDraft } from "./gmail.ts";
import { generateIdentityDraft } from "./identity.ts";
import { logDecision } from "./logger.ts";
import { sendDiscordNotification } from "../discord-notify/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

type TriageCategory = "URGENT" | "NEEDS_REPLY" | "FYI" | "JUNK";

function triageEmail(email: {
  subject: string;
  sender: string;
  body: string;
  labelIds: string[];
}): { category: TriageCategory; reason: string } {
  const subjectLower = email.subject.toLowerCase();
  const bodyLower = email.body.toLowerCase();
  const sender = email.sender.toLowerCase();

  // URGENT : délais courts, financements, audits
  const urgentSignals = [
    "urgent", "relance", "deadline", "échéance", "opco", "atlas", "akto",
    "qualiopi", "audit", "dossier incomplet", "aujourd'hui", "demain",
    "immédiatement", "asap", "délai", "retard",
  ];
  if (urgentSignals.some(s => subjectLower.includes(s) || bodyLower.slice(0,500).includes(s))) {
    return { category: "URGENT", reason: `Signal urgent détecté dans le sujet ou le corps` };
  }

  // JUNK : newsletters, notifications automatiques
  const junkSignals = [
    "unsubscribe", "se désabonner", "newsletter", "noreply", "no-reply",
    "notification", "donotreply", "automated", "mailer-daemon",
  ];
  if (junkSignals.some(s => bodyLower.includes(s) || sender.includes(s))) {
    return { category: "JUNK", reason: "Newsletter ou notification automatique" };
  }

  // FYI : CC, notifications informatives
  if (email.labelIds.includes("CATEGORY_UPDATES") || email.labelIds.includes("CATEGORY_PROMOTIONS")) {
    return { category: "FYI", reason: "Email categorisé automatiquement par Gmail" };
  }

  // NEEDS_REPLY : tout ce qui reste et semble attendre une réponse
  const replySignals = ["?", "pourriez-vous", "pouvez-vous", "merci de", "svp", "s'il vous plaît"];
  if (replySignals.some(s => subjectLower.includes(s) || bodyLower.slice(0,300).includes(s))) {
    return { category: "NEEDS_REPLY", reason: "Email contient une question ou demande de réponse" };
  }

  return { category: "FYI", reason: "Email informatif sans action requise détectée" };
}

serve(async (req) => {
  const startTime = Date.now();
  const results = { URGENT: 0, NEEDS_REPLY: 0, FYI: 0, JUNK: 0, errors: 0 };

  try {
    // Récupérer le timestamp du dernier scan
    const { data: lastScan } = await supabase
      .from("agent_memory")
      .select("value")
      .eq("agent", "inbox_twin")
      .eq("key", "last_scan_at")
      .single();

    const since = lastScan?.value?.timestamp
      ? new Date(lastScan.value.timestamp)
      : new Date(Date.now() - 3600 * 1000); // dernière heure par défaut

    const accessToken = await getGoogleAccessToken(
      Deno.env.get("GOOGLE_CLIENT_ID")!,
      Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      Deno.env.get("GOOGLE_REFRESH_TOKEN")!
    );

    const emails = await fetchNewEmails(accessToken, since);

    for (const email of emails) {
      try {
        // Vérifier si déjà traité
        const { data: existing } = await supabase
          .from("emails_processed")
          .select("id")
          .eq("gmail_message_id", email.id)
          .single();
        if (existing) continue;

        // Triage
        const { category, reason } = triageEmail(email);
        results[category]++;

        // Log décision
        const decisionId = await logDecision(supabase, {
          agent: "inbox_twin",
          action: "triage",
          inputSummary: `From: ${email.sender} | Subject: ${email.subject}`,
          outputSummary: `${category}: ${reason}`,
          confidence: 0.8,
          metadata: { gmail_message_id: email.id, category, reason },
        });

        // Générer draft pour URGENT et NEEDS_REPLY
        let draftId: string | undefined;
        let draftText: string | undefined;
        let styleConfidence = 0;

        if (category === "URGENT" || category === "NEEDS_REPLY") {
          const result = await generateIdentityDraft(supabase, email);
          draftText = result.draft;
          styleConfidence = result.confidence;
          draftId = await createDraft(accessToken, email.sender, email.subject, draftText, email.threadId);
        }

        // Stocker dans emails_processed
        await supabase.from("emails_processed").insert({
          gmail_message_id: email.id,
          thread_id: email.threadId,
          subject: email.subject,
          sender: email.sender,
          received_at: email.receivedAt.toISOString(),
          triage_category: category,
          triage_reason: reason,
          draft_id: draftId,
          draft_text: draftText,
          style_confidence: styleConfidence,
          decision_log_id: decisionId,
        });

      } catch (emailErr) {
        results.errors++;
        console.error(`Error processing email ${email.id}:`, emailErr);
      }
    }

    // Mettre à jour last_scan_at
    await supabase.from("agent_memory").upsert({
      agent: "inbox_twin",
      key: "last_scan_at",
      value: { timestamp: new Date().toISOString(), emails_processed: emails.length },
    }, { onConflict: "agent,key" });

    // Notification Discord si URGENT
    if (results.URGENT > 0) {
      await sendDiscordNotification(
        `🚨 **InboxTwin** — ${results.URGENT} email(s) URGENT, ${results.NEEDS_REPLY} NEEDS_REPLY, ${results.FYI} FYI, ${results.JUNK} JUNK\nDrafts prêts dans Gmail.`
      );
    }

    const elapsed = Date.now() - startTime;
    return new Response(JSON.stringify({ ...results, elapsed_ms: elapsed, emails_scanned: emails.length }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
```

- [ ] **Step 4.4 : Commit partiel**

```bash
git add supabase/functions/inbox-twin/gmail.ts
git add supabase/functions/inbox-twin/logger.ts
git add supabase/functions/inbox-twin/index.ts
git commit -m "feat(inbox-twin): email scanner + triage URGENT/NEEDS_REPLY/FYI/JUNK + observability logging"
```

---

## Task 5 : InboxTwin — Filtre identitaire (le cœur du système)

**But :** Implémenter `generateIdentityDraft` — la fonction qui cherche sémantiquement dans identity_corpus et génère un draft dans la voix de Laurens. C'est le signal clé : si ça marche ici, ça marchera sur tous les autres agents.

**Files:**
- Create: `supabase/functions/inbox-twin/identity.ts`

- [ ] **Step 5.1 : Écrire le filtre identitaire**

Créer `supabase/functions/inbox-twin/identity.ts` :

```typescript
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GmailMessage } from "./gmail.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function vectorize(text: string): Promise<number[]> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ input: text.slice(0, 2000) }),
  });
  const data = await resp.json();
  return data.embedding;
}

async function findSimilarEmails(
  supabase: SupabaseClient,
  embedding: number[],
  limit = 5
): Promise<{ content: string; similarity: number }[]> {
  const { data } = await supabase.rpc("match_identity_corpus", {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: limit,
    filter_source: "gmail_sent",
  });
  return data ?? [];
}

async function callLLM(prompt: string): Promise<string> {
  // Utilise Supabase AI (Deno) ou un endpoint OpenAI-compatible
  // En phase 1 : appel direct à l'API Anthropic via ANTHROPIC_API_KEY
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in Supabase secrets");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json();
  return data.content?.[0]?.text ?? "";
}

export async function generateIdentityDraft(
  supabase: SupabaseClient,
  email: GmailMessage
): Promise<{ draft: string; confidence: number }> {
  // 1. Vectoriser l'email entrant
  const incomingText = `${email.subject}\n${email.body.slice(0, 1000)}`;
  const embedding = await vectorize(incomingText);

  // 2. Trouver les emails similaires que Laurens a envoyés
  const similarEmails = await findSimilarEmails(supabase, embedding);
  const confidence = similarEmails.length > 0 ? similarEmails[0].similarity : 0.5;

  // 3. Construire le contexte d'exemples
  const examples = similarEmails
    .map((e, i) => `=== Exemple ${i + 1} (similarité: ${e.similarity.toFixed(2)}) ===\n${e.content.slice(0, 400)}`)
    .join("\n\n");

  // 4. Générer le draft avec le filtre identitaire
  const prompt = `Tu es l'assistant de Laurens. Tu dois rédiger une réponse à cet email EN TE BASANT EXCLUSIVEMENT sur la façon dont Laurens écrit — pas sur ta façon de faire.

VOICI COMMENT LAURENS ÉCRIT (ses vrais emails passés, similaires à ce contexte) :
${examples || "Pas d'exemples similaires trouvés — utilise un ton professionnel et direct."}

EMAIL À TRAITER :
De : ${email.sender}
Sujet : ${email.subject}
Corps : ${email.body.slice(0, 800)}

INSTRUCTIONS :
- Copie exactement son registre de langue, ses tournures, sa façon d'ouvrir et de clore
- Sois direct et professionnel comme lui
- Ne surexplique pas
- Longueur similaire à ses exemples
- En français sauf si l'email est en anglais

Génère uniquement le corps de la réponse, sans objet, sans salutation de début si Laurens ne les utilise pas.`;

  const draft = await callLLM(prompt);

  return { draft, confidence };
}
```

- [ ] **Step 5.2 : Créer la fonction SQL de recherche vectorielle**

```sql
-- Via mcp__claude_ai_Supabase__apply_migration
create or replace function match_identity_corpus(
  query_embedding vector(1536),
  match_threshold float default 0.75,
  match_count int default 5,
  filter_source text default null
)
returns table(id uuid, content text, source text, similarity float)
language sql stable
as $$
  select
    id, content, source,
    1 - (embedding <=> query_embedding) as similarity
  from identity_corpus
  where
    (filter_source is null or source = filter_source)
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 5.3 : Ajouter ANTHROPIC_API_KEY aux secrets Supabase**

```
Dans Supabase Dashboard → Settings → Edge Functions → Secrets :
ANTHROPIC_API_KEY=<ta clé Anthropic>
```

- [ ] **Step 5.4 : Déployer InboxTwin complet**

```
mcp__claude_ai_Supabase__deploy_edge_function(
  project_id: "<project_id>",
  name: "inbox-twin",
  entrypoint_path: "supabase/functions/inbox-twin/index.ts"
)
```

- [ ] **Step 5.5 : Test manuel du filtre identitaire**

```bash
# Déclencher InboxTwin manuellement
curl -X POST https://<project_ref>.supabase.co/functions/v1/inbox-twin \
  -H "Authorization: Bearer <anon_key>"
```

Attendu :
```json
{"URGENT": 1, "NEEDS_REPLY": 3, "FYI": 8, "JUNK": 2, "errors": 0, "elapsed_ms": 4200, "emails_scanned": 14}
```

Vérifier la qualité du filtre identitaire :
```sql
select
  subject, sender, triage_category, style_confidence, draft_text
from emails_processed
where triage_category in ('URGENT','NEEDS_REPLY')
order by processed_at desc limit 5;
```

**Signal clé :** si `style_confidence > 0.78` et que les drafts sonnent comme Laurens → le filtre fonctionne, les autres agents peuvent être câblés. Si `style_confidence < 0.6` → revoir l'ingestion ou la taille du corpus.

- [ ] **Step 5.6 : Commit**

```bash
git add supabase/functions/inbox-twin/identity.ts
git add supabase/migrations/002_match_function.sql
git commit -m "feat(inbox-twin): identity filter — semantic search on style_dna + LLM draft in Laurens voice"
```

---

## Task 6 : Discord notification

**But :** Webhook entrant Discord pour notifier les emails urgents et permettre des commandes basiques.

**Files:**
- Create: `supabase/functions/discord-notify/index.ts`

- [ ] **Step 6.1 : Créer le webhook Discord**

Dans Discord → ton serveur → Paramètres du canal → #laurens-os → Intégrations → Webhooks → Nouveau webhook.

Copier l'URL. La stocker dans Supabase secrets : `DISCORD_WEBHOOK_URL`.

- [ ] **Step 6.2 : Écrire la fonction de notification**

Créer `supabase/functions/discord-notify/index.ts` :

```typescript
export async function sendDiscordNotification(message: string): Promise<void> {
  const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Laurens OS",
      avatar_url: "https://em-content.zobj.net/source/twitter/376/brain_1f9e0.png",
      content: message,
    }),
  });
}

export async function sendDiscordEmbed(params: {
  title: string;
  description: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}): Promise<void> {
  const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Laurens OS",
      embeds: [{
        title: params.title,
        description: params.description,
        color: params.color ?? 0x5865F2,
        fields: params.fields ?? [],
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}
```

- [ ] **Step 6.3 : Déployer discord-notify**

```
mcp__claude_ai_Supabase__deploy_edge_function(
  project_id: "<project_id>",
  name: "discord-notify",
  entrypoint_path: "supabase/functions/discord-notify/index.ts"
)
```

- [ ] **Step 6.4 : Tester le webhook**

```bash
curl -X POST https://<project_ref>.supabase.co/functions/v1/discord-notify \
  -H "Authorization: Bearer <anon_key>" \
  -H "Content-Type: application/json" \
  -d '{"message": "🧠 Laurens OS en ligne. Système opérationnel."}'
```

Attendu : message apparaît dans #laurens-os Discord.

- [ ] **Step 6.5 : Commit**

```bash
git add supabase/functions/discord-notify/
git commit -m "feat(discord): webhook notification for urgent emails and system events"
```

---

## Task 7 : Scheduling — InboxTwin horaire + briefing matin

**But :** pg_cron déclenche InboxTwin toutes les heures et le briefing matin à 8h.

**Files:**
- Create: `supabase/migrations/002_pgcron.sql`
- Create: `supabase/functions/morning-briefing/index.ts`

- [ ] **Step 7.1 : Configurer pg_cron**

Créer `supabase/migrations/002_pgcron.sql` :

```sql
-- InboxTwin : toutes les heures
select cron.schedule(
  'inbox-twin-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/inbox-twin',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- Morning briefing : tous les jours à 8h00
select cron.schedule(
  'morning-briefing-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/morning-briefing',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
```

- [ ] **Step 7.2 : Écrire le briefing matin**

Créer `supabase/functions/morning-briefing/index.ts` :

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken, createDraft } from "../inbox-twin/gmail.ts";
import { sendDiscordEmbed } from "../discord-notify/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async () => {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);

  // Stats InboxTwin depuis hier
  const { data: emailStats } = await supabase
    .from("emails_processed")
    .select("triage_category, count(*)")
    .gte("processed_at", yesterday.toISOString());

  const stats = { URGENT: 0, NEEDS_REPLY: 0, FYI: 0, JUNK: 0 };
  for (const row of emailStats ?? []) {
    stats[row.triage_category as keyof typeof stats] = parseInt(row.count);
  }

  // Emails urgents sans draft validé
  const { data: urgentPending } = await supabase
    .from("emails_processed")
    .select("subject, sender")
    .eq("triage_category", "URGENT")
    .gte("processed_at", yesterday.toISOString())
    .limit(5);

  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  const briefingText = `🧠 LAURENS OS — Briefing du ${today}

📧 BOÎTE MAIL (dernières 24h)
• ${stats.URGENT} URGENT · ${stats.NEEDS_REPLY} NEEDS REPLY · ${stats.FYI} FYI · ${stats.JUNK} JUNK
• Drafts prêts dans Gmail pour les emails URGENT et NEEDS REPLY

${urgentPending?.length ? `⚠️ URGENTS EN ATTENTE\n${urgentPending.map(e => `• ${e.sender} — ${e.subject}`).join("\n")}` : "✅ Aucun urgent non traité"}

---
Bonne journée. Laurens OS travaille pendant que tu te concentres.`;

  // Créer le draft Gmail du briefing
  const accessToken = await getGoogleAccessToken(
    Deno.env.get("GOOGLE_CLIENT_ID")!,
    Deno.env.get("GOOGLE_CLIENT_SECRET")!,
    Deno.env.get("GOOGLE_REFRESH_TOKEN")!
  );

  await createDraft(accessToken, "me", `🧠 Briefing Laurens OS — ${today}`, briefingText);

  // Notification Discord condensée
  await sendDiscordEmbed({
    title: `🧠 Briefing ${today}`,
    description: briefingText,
    color: 0x00b4d8,
  });

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 7.3 : Appliquer la migration pg_cron**

```
mcp__claude_ai_Supabase__apply_migration(
  project_id: "<project_id>",
  name: "002_pgcron",
  query: <contenu de 002_pgcron.sql>
)
```

- [ ] **Step 7.4 : Déployer morning-briefing**

```
mcp__claude_ai_Supabase__deploy_edge_function(
  project_id: "<project_id>",
  name: "morning-briefing",
  entrypoint_path: "supabase/functions/morning-briefing/index.ts"
)
```

- [ ] **Step 7.5 : Vérifier les jobs pg_cron**

```sql
select jobname, schedule, active, jobid from cron.job;
-- Attendu : 2 jobs (inbox-twin-hourly, morning-briefing-daily)
```

- [ ] **Step 7.6 : Test manuel du briefing**

```bash
curl -X POST https://<project_ref>.supabase.co/functions/v1/morning-briefing \
  -H "Authorization: Bearer <anon_key>"
```

Attendu : draft apparaît dans Gmail + embed Discord dans #laurens-os.

- [ ] **Step 7.7 : Commit final Phase 1**

```bash
git add supabase/migrations/002_pgcron.sql
git add supabase/functions/morning-briefing/
git commit -m "feat(scheduling): pg_cron hourly InboxTwin + daily 8h morning briefing draft"
```

---

## Validation finale Phase 1

- [ ] **Check complet**

```sql
-- Toutes les tables existent
select count(*) from information_schema.tables where table_schema = 'public';
-- Attendu : 12

-- Données dans identity_corpus
select source, count(*) from identity_corpus group by source;
-- Attendu : gmail_sent | ~487

-- InboxTwin a tourné
select count(*), min(processed_at), max(processed_at) from emails_processed;

-- Observabilité opérationnelle
select agent, action, count(*) from decisions_log group by agent, action;

-- Cron actif
select jobname, active from cron.job;
```

- [ ] **Signal filtre identitaire**

```sql
select avg(style_confidence), min(style_confidence), max(style_confidence)
from emails_processed
where triage_category in ('URGENT','NEEDS_REPLY');
```

**Critère de passage en Phase 2 :** `avg(style_confidence) > 0.75`
Si < 0.75 → augmenter le corpus (plus d'emails, Drive docs) avant de câbler les autres agents.

---

## Ce qui vient en Phase 2

- DriveWatcher + ingestion Drive dans identity_corpus
- LearnerAgent (RTBL → Supabase learners table)
- CodeTwin (webhook GitHub)
- IdeaTwin + ContentTwin
- Discord bot interactif (commandes bidirectionnelles)
- ImmobilierTwin

**AdminTwin Qualiopi en Phase 3** — quand le système de validation est mature et que `style_confidence` est stable.
