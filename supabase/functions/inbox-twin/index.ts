import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// TYPES
// ============================================================

interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: Date;
  labelIds: string[];
}

type TriageCategory = "URGENT" | "NEEDS_REPLY" | "FYI" | "JUNK";
type RelationshipType = "interne" | "banque_formel" | "client_immo" | "partenaire" | "veille" | "inconnu";

interface ApplyLabelsResult {
  success: boolean;
  appliedIds: string[];
  errors: string[];
}

// ============================================================
// GMAIL CLIENT
// ============================================================

async function getGoogleAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`OAuth refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
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

async function fetchNewEmails(accessToken: string, afterTimestamp: Date): Promise<GmailMessage[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = afterTimestamp;
  const dateStr = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const query = `in:inbox after:${dateStr} -from:me`;
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listResp.json();
  if (!list.messages?.length) return [];

  const messages: GmailMessage[] = [];
  for (const msg of list.messages) {
    const full = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then((r) => r.json());
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

async function fetchThreadContext(accessToken: string, threadId: string): Promise<string> {
  try {
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const thread = await resp.json();
    const messages = (thread.messages || []).slice(-3);
    return messages.map((msg: any) => {
      const hdrs = msg.payload?.headers || [];
      const get = (n: string) => hdrs.find((h: any) => h.name === n)?.value || "";
      return `De: ${get("From")}\n${extractBody(msg.payload).slice(0, 300)}`;
    }).join("\n---\n");
  } catch {
    return "";
  }
}

async function createDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<string> {
  const message = [`To: ${to}`, `Subject: Re: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body].join("\r\n");
  const bytes = new TextEncoder().encode(message);
  const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: encoded, ...(threadId ? { threadId } : {}) } }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Draft creation failed: ${JSON.stringify(data.error)}`);
  return data.id;
}

async function fetchUserLabels(accessToken: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  return (data.labels ?? []).filter((l: any) => l.type === "user");
}

async function getOrCreateLabel(
  accessToken: string,
  name: string,
  existingLabels: { id: string; name: string }[]
): Promise<string | null> {
  const existing = existingLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  const created = await resp.json();
  if (created.error) {
    console.error(`Label creation failed for "${name}":`, JSON.stringify(created.error));
    return null;
  }
  return created.id ?? null;
}

async function applyLabels(accessToken: string, messageId: string, labelIds: string[], removeInbox = false): Promise<ApplyLabelsResult> {
  const validIds = labelIds.filter(Boolean);
  if (!validIds.length) return { success: true, appliedIds: [], errors: [] };
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      addLabelIds: validIds,
      ...(removeInbox ? { removeLabelIds: ["INBOX"] } : {}),
    }),
  });
  const data = await resp.json();
  if (data.error) {
    const errMsg = JSON.stringify(data.error);
    console.error("applyLabels failed:", errMsg);
    return { success: false, appliedIds: [], errors: [errMsg] };
  }
  return { success: true, appliedIds: validIds, errors: [] };
}

// ============================================================
// LABEL RULES
// ============================================================

const LABEL_RULES: { label: string; match: (e: GmailMessage) => boolean }[] = [
  // ========== START ACADEMY ==========
  {
    label: "Start Academy/Interne",
    match: (e) => /@start-academy\.fr/i.test(e.sender)
      && !e.sender.toLowerCase().includes("formation@start-academy.fr"),
  },
  {
    label: "Start Academy/Catalogue",
    match: (e) => e.sender.toLowerCase().includes("formation@start-academy.fr")
      && e.subject.toLowerCase().includes("nouvelle entrée"),
  },
  // ========== FORMATION ==========
  {
    label: "Formation/OPCO",
    match: (e) => ["opco", "atlas", "akto", "sous-traitance opco", "prise en charge", "dossier incomplet"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Formation/Qualiopi",
    match: (e) => ["qualiopi", "bilan pédagogique", "bpf", "dreets", "of certifié",
      "monactiviteformation", "travail.gouv.fr"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Formation/Apprenants",
    match: (e) => ["dendreo", "inscription formation", "apprenant", "stagiaire",
      "confirmation de votre formation"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Formation/Programmes",
    match: (e) => ["tracfin", "programme de formation", "conception programme"]
      .some((s) => e.subject.toLowerCase().includes(s)),
  },
  // ========== IMMOBILIER ==========
  {
    label: "Immobilier/Nestenn",
    match: (e) => ["@nestenn.com", "@iadfrance.fr"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Immobilier/Agences",
    match: (e) => ["@lagenceimmo.eu", "@kwfrance.com", "@imagimmo.com", "lachouette.immo",
      "cimiez-boulevard.fr", "beausite-estate.com", "@century21.fr", "matim.immo", "@savills.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Immobilier/Coaching-Individuel",
    match: (e) => ["coaching individuel", "suivi personnalisé", "session coaching"]
      .some((s) => e.subject.toLowerCase().includes(s))
      && ["@nestenn.com", "@iadfrance.fr", "@lagenceimmo.eu", "@kwfrance.com"]
        .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Immobilier/Veille-Alertes",
    match: (e) => e.sender.toLowerCase().includes("alertes.seloger.com"),
  },
  // ========== BUSINESS ==========
  {
    label: "Banque/Finance",
    match: (e) => ["@bpmed.fr", "bpce.fr", "crédit bail", "credit bail"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Admin/Signatures",
    match: (e) => ["adobesign", "docusign", "signature demandée"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Admin/Factures",
    match: (e) => ["facture", "invoice", "paiement", "règlement", "avoir"]
      .some((s) => e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Business/Matériel",
    match: (e) => ["cap3000business@apple.com", "@email.apple.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Business/Assurance",
    match: (e) => e.sender.toLowerCase().includes("@groupe-bianco.fr"),
  },
  {
    label: "Business/Prestataires",
    match: (e) => ["juniormiageconcept.com", "sebastientedesco.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  // ========== VEILLE/IA (6 sous-labels) ==========
  {
    label: "Veille/IA-Newsletters",
    match: (e) => ["therundown.ai", "simple.ai", "logiaweb", "beehiiv.com", "dharmesh"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Veille/IA-Outils",
    match: (e) => ["heygen.com", "1min.ai", "genspark.ai", "openclaw"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Veille/IA-LLMs-Labs",
    match: (e) => ["anthropic", "openai.com", "@email.claude.com", "ollama.com", "mistral",
      "gemini-notes@google.com", "gemma"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s)),
  },
  {
    label: "Veille/IA-Formations",
    match: (e) => ["skool.com", "laccelerateuria.com", "naier"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Veille/IA-Immo",
    match: (e) => ["hoqi.app", "goflint"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Veille/IA-Events",
    match: (e) => ["realnewtech.com", "rent academy"]
      .some((s) => e.sender.toLowerCase().includes(s) || e.subject.toLowerCase().includes(s))
      || ["webinar", "webinaire"].some((s) => e.subject.toLowerCase().includes(s)),
  },
  // ========== DEV/TECH ==========
  {
    label: "Dev/GitHub",
    match: (e) => e.sender.toLowerCase().includes("github"),
  },
  {
    label: "Dev/Infra",
    match: (e) => ["supabase", "vercel.com", "airtable.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Dev/Outils-IA",
    match: (e) => ["e.read.ai", "gemini-notes@google.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  // ========== NOTIFICATIONS ==========
  {
    label: "Notifications/Google",
    match: (e) => e.sender.toLowerCase().includes("no-reply@accounts.google.com"),
  },
  {
    label: "Notifications/Meetings",
    match: (e) => ["e.read.ai", "gemini-notes"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
  {
    label: "Notifications/Apps",
    match: (e) => ["mail.app.supabase.io", "registration@vercel.com", "noreply@airtable.com"]
      .some((s) => e.sender.toLowerCase().includes(s)),
  },
];

function classifyWithLabels(email: GmailMessage): string[] {
  return LABEL_RULES.filter((r) => r.match(email)).map((r) => r.label);
}

// ============================================================
// RELATIONSHIP CLASSIFIER
// ============================================================

function classifyRelationship(sender: string): RelationshipType {
  const s = sender.toLowerCase();
  if (s.includes("@start-academy.fr")) return "interne";
  if (["@bpmed.fr", "cap3000business@apple.com", "@groupe-bianco.fr"].some((d) => s.includes(d))) return "banque_formel";
  if (["@nestenn.com", "@lagenceimmo.eu", "@kwfrance.com", "imagimo", "lachouette.immo", "cimiez-boulevard"].some((d) => s.includes(d))) return "client_immo";
  if (["@juniormiageconcept.com", "@sebastientedesco.com", "realnewtech.com"].some((d) => s.includes(d))) return "partenaire";
  if (["therundown.ai", "1min.ai", "heygen", "@skool.com", "@ollama.com", "@genspark.ai", "beehiiv.com"].some((d) => s.includes(d))) return "veille";
  return "inconnu";
}

const RELATIONSHIP_CONTEXT: Record<RelationshipType, string> = {
  interne: "Collègue interne de Start Academy — ton direct, informel, tutoiement, messages courts",
  banque_formel: "Interlocuteur bancaire ou financier — ton très formel, vouvoiement, précis et factuel",
  client_immo: "Client ou partenaire immobilier — ton professionnel, chaleureux, orienté résultat",
  partenaire: "Partenaire business externe — ton professionnel, collaboratif",
  veille: "Newsletter ou veille — pas de réponse à rédiger",
  inconnu: "Interlocuteur inconnu — ton professionnel, vouvoiement par défaut",
};

// ============================================================
// LOGGER
// ============================================================

async function logDecision(
  supabase: SupabaseClient,
  params: { agent: string; action: string; inputSummary: string; outputSummary: string; confidence: number; metadata?: Record<string, unknown> }
): Promise<string> {
  const { data, error } = await supabase
    .from("decisions_log")
    .insert({
      agent: params.agent,
      context: params.inputSummary,
      decision: params.action,
      outcome: params.outputSummary,
      metadata: { confidence: params.confidence, ...params.metadata },
    })
    .select("id")
    .single();
  if (error) console.error("decisions_log insert failed:", error);
  return data?.id ?? "";
}

// ============================================================
// FILTRE IDENTITAIRE
// ============================================================

async function vectorize(text: string): Promise<number[]> {
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}` },
    body: JSON.stringify({ model: "openai/text-embedding-ada-002", input: text.slice(0, 2000) }),
  });
  const data = await resp.json();
  if (!data.data?.[0]?.embedding) throw new Error(`Vectorization failed: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

async function findSimilarEmails(
  supabase: SupabaseClient,
  embedding: number[]
): Promise<{ content: string; similarity: number }[]> {
  const { data, error } = await supabase.rpc("match_identity_corpus", {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: 5,
    filter_source: "gmail_sent",
  });
  if (error) console.error("match_identity_corpus error:", error);
  return data ?? [];
}

async function generateIdentityDraft(
  supabase: SupabaseClient,
  email: GmailMessage,
  threadContext: string,
  relationship: RelationshipType
): Promise<{ draft: string; confidence: number }> {
  const embedding = await vectorize(`${email.subject}\n${email.body.slice(0, 1000)}`);
  const similarEmails = await findSimilarEmails(supabase, embedding);
  const confidence = similarEmails.length > 0 ? similarEmails[0].similarity : 0.5;

  const examples = similarEmails
    .map((e, i) => `=== Exemple ${i + 1} (similarité: ${e.similarity.toFixed(2)}) ===\n${e.content.slice(0, 400)}`)
    .join("\n\n");

  const threadSection = threadContext
    ? `\nCONTEXTE DU FIL (messages précédents) :\n${threadContext}\n`
    : "";

  const prompt = `Tu es l'assistant de Laurent MARX. Rédige une réponse EN TE BASANT EXCLUSIVEMENT sur la façon dont Laurent écrit.

RELATION AVEC L'EXPÉDITEUR : ${RELATIONSHIP_CONTEXT[relationship]}

EXEMPLES D'ÉCRITURE DE LAURENT (emails similaires) :
${examples || "Aucun exemple trouvé — adapte le ton à la relation ci-dessus."}
${threadSection}
EMAIL À TRAITER :
De : ${email.sender}
Sujet : ${email.subject}
Corps : ${email.body.slice(0, 800)}

INSTRUCTIONS STRICTES :
- Adapte OBLIGATOIREMENT le ton à la relation : ${RELATIONSHIP_CONTEXT[relationship]}
- Copie ses tournures, sa façon d'ouvrir et de clore
- Direct, pas de surexplication
- Longueur similaire à ses exemples
- Français sauf si l'email est en anglais
- Signature exacte si nécessaire : "Laurent MARX"

Génère uniquement le corps de la réponse.`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}` },
    body: JSON.stringify({ model: "anthropic/claude-haiku-4-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`);
  return { draft: data.choices?.[0]?.message?.content ?? "", confidence };
}

// ============================================================
// TRIAGE
// ============================================================

function triageEmail(email: GmailMessage): { category: TriageCategory; reason: string } {
  const subjectLower = email.subject.toLowerCase();
  const bodyLower = email.body.toLowerCase();
  const sender = email.sender.toLowerCase();
  const emailAgeHours = (Date.now() - email.receivedAt.getTime()) / (1000 * 3600);
  const isOld = emailAgeHours > 120; // > 5 jours

  // 1. Signatures → toujours URGENT (peu importe l'âge)
  const signatureSignals = ["adobesign", "docusign", "signature demandée", "signer"];
  if (signatureSignals.some((s) => sender.includes(s) || subjectLower.includes(s))) {
    return { category: "URGENT", reason: "Signature électronique en attente" };
  }

  // 2. Signaux urgents métier (seulement si email récent < 5 jours)
  if (!isOld) {
    const urgentSignals = ["urgent", "relance", "deadline", "échéance", "opco", "atlas", "akto",
      "qualiopi", "audit", "dossier incomplet", "aujourd'hui", "demain", "immédiatement",
      "asap", "délai", "retard", "crédit bail", "credit bail", "facturation directe", "règlement"];
    if (urgentSignals.some((s) => subjectLower.includes(s) || bodyLower.slice(0, 500).includes(s))) {
      return { category: "URGENT", reason: "Signal urgent détecté dans le sujet ou le corps" };
    }
  }

  // 3. Équipe interne → jamais JUNK
  if (sender.includes("@start-academy.fr")) {
    const replySignals = ["?", "pourriez-vous", "pouvez-vous", "merci de", "svp", "disponibilité", "peux-tu", "peut-on"];
    if (replySignals.some((s) => subjectLower.includes(s) || bodyLower.slice(0, 300).includes(s))) {
      return { category: "NEEDS_REPLY", reason: "Message interne Start Academy avec demande" };
    }
    return { category: "FYI", reason: "Message interne Start Academy" };
  }

  // 4. Partenaires business connus → NEEDS_REPLY
  const businessPartners = ["@nestenn.com", "@bpmed.fr", "@groupe-bianco.fr", "@lagenceimmo.eu",
    "@juniormiageconcept.com", "@sebastientedesco.com", "cap3000business@apple.com", "@kwfrance.com"];
  if (businessPartners.some((s) => sender.includes(s))) {
    return { category: "NEEDS_REPLY", reason: "Partenaire business reconnu" };
  }

  // 5. Invitations Calendar → FYI
  if (subjectLower.includes("invitation:") || subjectLower.includes("événement annulé") || subjectLower.includes("canceled event")) {
    return { category: "FYI", reason: "Invitation ou annulation agenda" };
  }

  // 6. Veille IA → FYI (avant filtre JUNK)
  const veilleIASenders = ["therundown.ai", "1min.ai", "heygen", "@skool.com", "@ollama.com",
    "@genspark.ai", "beehiiv.com", "@e.read.ai", "logiaweb", "openai", "mistral", "anthropic"];
  if (veilleIASenders.some((s) => sender.includes(s) || subjectLower.includes(s))) {
    return { category: "FYI", reason: "Newsletter Veille IA souscrite" };
  }

  // 7. Services utiles → FYI
  const usefulServices = ["@accounts.google.com", "@alertes.seloger.com", "supabase", "@read.ai", "github"];
  if (usefulServices.some((s) => sender.includes(s))) {
    return { category: "FYI", reason: "Alerte service utile" };
  }

  // 8. JUNK
  const junkDomains = ["yescapa.com", "chess.com"];
  if (junkDomains.some((s) => sender.includes(s))) {
    return { category: "JUNK", reason: "Promotion commerciale non liée au business" };
  }
  const junkSignals = ["unsubscribe", "se désabonner", "mailer-daemon", "donotreply", "automated"];
  if (junkSignals.some((s) => bodyLower.includes(s) || sender.includes(s))) {
    if (email.labelIds.includes("CATEGORY_PROMOTIONS")) {
      return { category: "JUNK", reason: "Newsletter promotionnelle non souscrite" };
    }
    return { category: "FYI", reason: "Notification automatique" };
  }

  // 9. Question directe → NEEDS_REPLY
  const replySignals = ["?", "pourriez-vous", "pouvez-vous", "merci de", "svp", "disponibilité", "rappeler", "confirmer"];
  if (replySignals.some((s) => subjectLower.includes(s) || bodyLower.slice(0, 300).includes(s))) {
    return { category: "NEEDS_REPLY", reason: "Email contient une question ou demande de réponse" };
  }

  return { category: "FYI", reason: "Email informatif sans action requise détectée" };
}

// ============================================================
// DISCORD
// ============================================================

type DiscordChannel = "urgent" | "atraiter" | "briefs" | "veille_ia" | "systeme";

const DISCORD_WEBHOOKS: Record<DiscordChannel, string | undefined> = {
  urgent:   Deno.env.get("DISCORD_WEBHOOK_URGENT"),
  atraiter: Deno.env.get("DISCORD_WEBHOOK_ATRAITER"),
  briefs:   Deno.env.get("DISCORD_WEBHOOK_BRIEFS"),
  veille_ia: Deno.env.get("DISCORD_WEBHOOK_VEILLE_IA"),
  systeme:  Deno.env.get("DISCORD_WEBHOOK_SYSTEME"),
};

function cleanSender(sender: string): string {
  return sender.replace(/"([^"]+)".*/, "$1").replace(/<[^>]+>/, "").trim() || sender;
}

function truncate(msg: string, max = 1900): string {
  return msg.length > max ? msg.slice(0, max) + "\n…_(liste tronquée)_" : msg;
}

async function sendDiscord(channel: DiscordChannel, content: string): Promise<void> {
  const url = DISCORD_WEBHOOKS[channel];
  if (!url) {
    console.error(`No webhook configured for channel: ${channel}`);
    return;
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncate(content) }),
    });
    if (!resp.ok) {
      console.error(`Discord ${channel} returned ${resp.status}: ${await resp.text()}`);
    }
  } catch (e) {
    console.error(`Discord ${channel} failed:`, e);
  }
}

function formatUrgent(email: { sender: string; subject: string; confidence: number }): string {
  const lowConf = email.confidence < 0.75 ? "\n⚠️ _Confiance faible — relire le draft_" : "";
  return `🚨 **URGENT**\n**De :** ${cleanSender(email.sender)}\n**Sujet :** ${email.subject}\n→ Draft prêt dans Gmail${lowConf}`;
}

function formatNeedsReply(email: { sender: string; subject: string; confidence: number }): string {
  const lowConf = email.confidence < 0.75 ? "\n⚠️ _Confiance faible — relire le draft_" : "";
  return `📩 **À TRAITER**\n**De :** ${cleanSender(email.sender)}\n**Sujet :** ${email.subject}\n→ Draft prêt dans Gmail${lowConf}`;
}

// ============================================================
// GOOGLE CALENDAR CLIENT  (Chantier #1)
// ============================================================

interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  location?: string;
  attendees: string[];
  conferenceUrl?: string;
}

async function fetchTodayEvents(accessToken: string): Promise<CalendarEvent[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", todayStart.toISOString());
  url.searchParams.set("timeMax", todayEnd.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "30");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();

  if (data.error) throw new Error(`Calendar API error: ${JSON.stringify(data.error)}`);

  return (data.items || []).map((item: any) => {
    const isAllDay = !!item.start?.date;
    return {
      id: item.id,
      summary: item.summary || "(Sans titre)",
      start: new Date(item.start?.dateTime || item.start?.date),
      end: new Date(item.end?.dateTime || item.end?.date),
      isAllDay,
      location: item.location,
      attendees: (item.attendees || [])
        .filter((a: any) => !a.self && a.responseStatus !== "declined")
        .map((a: any) => a.displayName || a.email),
      conferenceUrl: item.conferenceData?.entryPoints?.[0]?.uri || item.hangoutLink,
    };
  });
}

function detectScheduleConflicts(events: CalendarEvent[]): CalendarEvent[][] {
  const conflicts: CalendarEvent[][] = [];
  const timed = events.filter((e) => !e.isAllDay);

  for (let i = 0; i < timed.length; i++) {
    const overlapping = [timed[i]];
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].start < timed[i].end && timed[j].end > timed[i].start) {
        overlapping.push(timed[j]);
      }
    }
    if (overlapping.length > 1) conflicts.push(overlapping);
  }

  const seen = new Set<string>();
  return conflicts.filter((group) => {
    const key = group.map((e) => e.id).sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
}

function formatCalendarSection(events: CalendarEvent[]): string {
  if (events.length === 0) return "📅 **Agenda du jour** — Rien de prévu, journée libre 🎉\n";

  const conflicts = detectScheduleConflicts(events);
  let section = `📅 **Agenda du jour** — ${events.length} événement${events.length > 1 ? "s" : ""}\n`;

  if (conflicts.length > 0) {
    section += `\n⚠️ **CONFLIT D'AGENDA DÉTECTÉ** ⚠️\n`;
    for (const group of conflicts) {
      section += `   ${group.length} événements en simultané :\n`;
      for (const e of group) {
        const time = e.isAllDay ? "Journée" : `${formatTime(e.start)}-${formatTime(e.end)}`;
        section += `   • ${time} : ${e.summary}${e.location ? ` (${e.location})` : ""}\n`;
      }
    }
    section += "\n";
  }

  section += "\n";
  for (const e of events) {
    const time = e.isAllDay ? "🕐 Journée" : `🕐 ${formatTime(e.start)}-${formatTime(e.end)}`;
    section += `• ${time} — **${e.summary}**\n`;
    if (e.location) section += `  📍 ${e.location.slice(0, 80)}\n`;
    if (e.conferenceUrl) section += `  💻 ${e.conferenceUrl}\n`;
    if (e.attendees.length > 0 && e.attendees.length <= 5) {
      section += `  👥 ${e.attendees.join(", ")}\n`;
    } else if (e.attendees.length > 5) {
      section += `  👥 ${e.attendees.length} participants\n`;
    }
    section += "\n";
  }

  return section;
}

// ============================================================
// BRIEF MATIN
// ============================================================

async function buildBriefContent(supabase: SupabaseClient, accessToken: string): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  let msg = `📊 **BRIEF MATIN — ${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}**\n\n`;

  // ─── Agenda du jour (Chantier #1) ──────────────────────────
  try {
    const todayEvents = await fetchTodayEvents(accessToken);
    msg += formatCalendarSection(todayEvents);
  } catch (e) {
    console.error("Calendar fetch failed:", e);
    msg += `📅 **Agenda du jour** — _(non disponible : ${(e as Error).message})_\n`;
  }
  msg += "\n---\n\n";

  // ─── Relances en attente (Chantier #2) ─────────────────────
  try {
    const { data: relances } = await supabase
      .from("relances_pending")
      .select("recipient, subject, days_since_sent")
      .eq("dismissed", false)
      .eq("relance_sent", false)
      .order("days_since_sent", { ascending: false })
      .limit(10);

    if (relances && relances.length > 0) {
      msg += `🔔 **À relancer aujourd'hui** — ${relances.length} email${relances.length > 1 ? "s" : ""}\n\n`;
      for (const r of relances) {
        msg += `  · **${cleanSender(r.recipient)}** — ${(r.subject || "").slice(0, 60)} _(${r.days_since_sent}j)_\n`;
      }
      msg += "\n---\n\n";
    }
  } catch {
    // Table pas encore créée — ignorer silencieusement
  }

  // ─── Emails 24h ────────────────────────────────────────────
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: emails } = await supabase
    .from("emails_processed")
    .select("sender, subject, triage_label, draft_id")
    .gte("created_at", since24h)
    .order("created_at", { ascending: false });

  if (!emails?.length) {
    msg += "📧 Aucun email traité dans les dernières 24h.\n";
    return msg;
  }

  const urgent = emails.filter((e) => e.triage_label === "URGENT");
  const needsReply = emails.filter((e) => e.triage_label === "NEEDS_REPLY");
  const fyi = emails.filter((e) => e.triage_label === "FYI");
  const junk = emails.filter((e) => e.triage_label === "JUNK");

  const formatList = (items: { sender: string; subject: string }[]) =>
    items.map((e) => `  · **${cleanSender(e.sender)}** — ${e.subject.slice(0, 55)}`).join("\n");

  msg += `📧 **${emails.length} emails traités** (24 dernières heures)\n\n`;
  msg += urgent.length
    ? `🔴 **${urgent.length} URGENT${urgent.length > 1 ? "S" : ""}** — drafts prêts\n${formatList(urgent)}\n\n`
    : `✅ Aucun urgent\n\n`;
  if (needsReply.length) msg += `📩 **${needsReply.length} À TRAITER** — drafts prêts\n${formatList(needsReply)}\n\n`;
  if (fyi.length) msg += `📰 **${fyi.length} FYI** filtrés (veille IA, alertes)\n`;
  if (junk.length) msg += `🗑️ **${junk.length} JUNK** évités\n`;

  return msg;
}

// ============================================================
// MAIN
// ============================================================

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

serve(async (req) => {
  const startTime = Date.now();
  const results = { URGENT: 0, NEEDS_REPLY: 0, FYI: 0, JUNK: 0, errors: 0, emails_scanned: 0 };
  const body = await req.json().catch(() => ({}));
  const isRecap = body?.recap === true;

  try {
    const { data: lastScan } = await supabase.from("agent_memory").select("value")
      .eq("agent", "inbox_twin").eq("key", "last_scan_at").single();
    const rawValue = lastScan?.value;
    const parsedValue = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    const since = parsedValue?.timestamp
      ? new Date(parsedValue.timestamp)
      : new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const accessToken = await getGoogleAccessToken();
    const emails = await fetchNewEmails(accessToken, since);
    results.emails_scanned = emails.length;

    const userLabels = await fetchUserLabels(accessToken);

    // Tracked pour Discord (seulement les nouveaux emails de ce run)
    const urgentForDiscord: { sender: string; subject: string; confidence: number }[] = [];
    const needsReplyForDiscord: { sender: string; subject: string; confidence: number }[] = [];

    for (const email of emails) {
      try {
        const { data: existing } = await supabase.from("emails_processed")
          .select("id").eq("gmail_id", email.id).single();
        if (existing) continue;

        const { category, reason } = triageEmail(email);
        results[category]++;

        const decisionId = await logDecision(supabase, {
          agent: "inbox_twin",
          action: "triage",
          inputSummary: `From: ${email.sender} | Subject: ${email.subject}`,
          outputSummary: `${category}: ${reason}`,
          confidence: 0.8,
          metadata: { gmail_message_id: email.id, category, reason },
        });

        let draftId: string | undefined;
        let draftText: string | undefined;
        let styleConfidence = 0;

        if (category === "URGENT" || category === "NEEDS_REPLY") {
          const relationship = classifyRelationship(email.sender);
          const threadContext = await fetchThreadContext(accessToken, email.threadId);
          const result = await generateIdentityDraft(supabase, email, threadContext, relationship);
          draftText = result.draft;
          styleConfidence = result.confidence;
          draftId = await createDraft(accessToken, email.sender, email.subject, draftText, email.threadId);

          // Tracker pour Discord notifs (pas de re-triage)
          if (category === "URGENT") {
            urgentForDiscord.push({ sender: email.sender, subject: email.subject, confidence: styleConfidence });
          } else {
            needsReplyForDiscord.push({ sender: email.sender, subject: email.subject, confidence: styleConfidence });
          }
        }

        // Labels Gmail (JUNK ignoré)
        const labelDebug: { labels_matched: string[]; labels_created: string[]; labels_applied: string[]; labels_errors: string[] } =
          { labels_matched: [], labels_created: [], labels_applied: [], labels_errors: [] };

        if (category !== "JUNK") {
          try {
            const matchedNames = classifyWithLabels(email);
            labelDebug.labels_matched = matchedNames;
            const labelIds: string[] = [];
            for (const name of matchedNames) {
              const isExisting = userLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
              const id = await getOrCreateLabel(accessToken, name, userLabels);
              if (id) {
                labelIds.push(id);
                if (!isExisting) labelDebug.labels_created.push(name);
              } else {
                labelDebug.labels_errors.push(`getOrCreateLabel returned null for "${name}"`);
              }
            }
            if (labelIds.length) {
              const applyResult = await applyLabels(accessToken, email.id, labelIds, category === "FYI");
              labelDebug.labels_applied = applyResult.appliedIds;
              if (!applyResult.success) {
                labelDebug.labels_errors.push(...applyResult.errors);
              }
            }
          } catch (labelErr) {
            console.error("Label classification failed:", labelErr);
            labelDebug.labels_errors.push(String(labelErr));
          }
        }

        // Log labels dans decisions_log pour traçabilité
        if (category !== "JUNK" && labelDebug.labels_matched.length > 0) {
          await logDecision(supabase, {
            agent: "inbox_twin",
            action: "labels_applied",
            inputSummary: `From: ${email.sender} | Subject: ${email.subject}`,
            outputSummary: labelDebug.labels_errors.length > 0
              ? `ERRORS: ${labelDebug.labels_errors.join("; ")}`
              : `Applied: ${labelDebug.labels_applied.length}/${labelDebug.labels_matched.length} labels`,
            confidence: labelDebug.labels_errors.length > 0 ? 0 : 1,
            metadata: { gmail_message_id: email.id, ...labelDebug },
          });
        }

        const { error: insertError } = await supabase.from("emails_processed").insert({
          gmail_id: email.id,
          thread_id: email.threadId,
          subject: email.subject,
          sender: email.sender,
          received_at: email.receivedAt.toISOString(),
          triage_label: category,
          status: reason,
          draft_id: draftId,
          draft_text: draftText,
          metadata: {
            style_confidence: styleConfidence,
            decision_log_id: decisionId,
            relationship: classifyRelationship(email.sender),
            labels_matched: labelDebug.labels_matched,
            labels_created: labelDebug.labels_created,
            labels_applied_ids: labelDebug.labels_applied,
            labels_errors: labelDebug.labels_errors,
          },
        });
        if (insertError) console.error("emails_processed insert failed:", insertError);

      } catch (emailErr) {
        results.errors++;
        console.error(`Error processing email ${email.id}:`, emailErr);
      }
    }

    if (emails.length > 0) {
      await supabase.from("agent_memory").upsert(
        { agent: "inbox_twin", key: "last_scan_at", value: { timestamp: new Date().toISOString(), emails_processed: emails.length } },
        { onConflict: "agent,key" }
      );
    }

    // Discord
    if (isRecap) {
      const briefContent = await buildBriefContent(supabase, accessToken);
      const webhookUrl = DISCORD_WEBHOOKS.briefs;
      let discordStatus = "not_called";
      if (webhookUrl) {
        try {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: truncate(briefContent) }),
          });
          discordStatus = `${resp.status} ${resp.ok ? "ok" : await resp.text()}`;
        } catch (e) {
          discordStatus = `error: ${(e as Error).message}`;
        }
      } else {
        discordStatus = "no_webhook_url";
      }
      return new Response(JSON.stringify({
        ...results,
        elapsed_ms: Date.now() - startTime,
        debug: { brief_length: briefContent.length, discord_status: discordStatus },
      }), { headers: { "Content-Type": "application/json" } });
    } else {
      // URGENT — seuil à 2
      if (urgentForDiscord.length === 1 || urgentForDiscord.length === 2) {
        for (const e of urgentForDiscord) await sendDiscord("urgent", formatUrgent(e));
      } else if (urgentForDiscord.length >= 3) {
        const list = urgentForDiscord
          .map((e) => `• **${cleanSender(e.sender)}** — ${e.subject.slice(0, 55)}`)
          .join("\n");
        await sendDiscord("urgent", `🚨 **${urgentForDiscord.length} URGENTS** — drafts prêts\n${list}`);
      }

      // À TRAITER — seuil à 3
      if (needsReplyForDiscord.length >= 1 && needsReplyForDiscord.length <= 3) {
        for (const e of needsReplyForDiscord) await sendDiscord("atraiter", formatNeedsReply(e));
      } else if (needsReplyForDiscord.length > 3) {
        const list = needsReplyForDiscord
          .map((e) => `• **${cleanSender(e.sender)}** — ${e.subject.slice(0, 55)}`)
          .join("\n");
        await sendDiscord("atraiter", `📩 **${needsReplyForDiscord.length} À TRAITER** — drafts prêts\n${list}`);
      }
    }

    // Rapport d'erreurs → #systeme
    if (results.errors > 0) {
      await sendDiscord("systeme",
        `⚠️ swift-responder — ${results.errors} erreur(s) sur ${results.emails_scanned} emails scannés (${Date.now() - startTime}ms)`
      );
    }

    return new Response(JSON.stringify({ ...results, elapsed_ms: Date.now() - startTime }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
