import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// TYPES
// ============================================================

interface VeilleEmail {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: Date;
  labels: string[];
}

interface Cluster {
  representative: VeilleEmail;
  mentions: VeilleEmail[];
  similarity: number;
}

interface DigestResult {
  themes: string[];
  markdown: string;
  html: string;
  top3: Array<{ titre: string; resume: string; sources: string[]; score_pertinence: number; pourquoi_laurent: string }>;
  opportunites_formation: Array<{ news: string; angle: string }>;
  outils_a_tester: Array<{ name: string; why: string }>;
  tendances_de_fond: string[];
  rundown_focus: { actus: Array<{ titre: string; resume_developpe: string; pourquoi_laurent: string }>; synthese_semaine: string } | null;
  score_pertinence_moyen: number;
  cost_tokens: number;
  cost_usd: number;
}

// ============================================================
// CONFIG
// ============================================================

const VEILLE_LABELS = [
  "Veille/IA-Newsletters",
  "Veille/IA-Outils",
  "Veille/IA-LLMs-Labs",
  "Veille/IA-Formations",
  "Veille/IA-Immo",
  "Veille/IA-Events",
];

const SIMILARITY_THRESHOLD = 0.85;

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

async function fetchUserLabels(accessToken: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (data.error) throw new Error(`fetchUserLabels failed: ${JSON.stringify(data.error)}`);
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
  existingLabels.push({ id: created.id, name });
  return created.id ?? null;
}

async function fetchEmailsWithFullContent(
  accessToken: string,
  query: string
): Promise<VeilleEmail[]> {
  const userLabels = await fetchUserLabels(accessToken);
  const labelIdToName = Object.fromEntries(userLabels.map((l) => [l.id, l.name]));

  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "100");

  const listResp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  const list = await listResp.json();
  if (list.error) throw new Error(`Gmail list failed: ${JSON.stringify(list.error)}`);
  if (!list.messages?.length) return [];

  const emails: VeilleEmail[] = [];

  // Parallélisation par chunks de 10 pour éviter le rate limit
  const chunks: { id: string }[][] = [];
  for (let i = 0; i < list.messages.length; i += 10) {
    chunks.push(list.messages.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (msg: { id: string }) => {
        const full = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        ).then((r) => r.json());

        const headers = full.payload?.headers || [];
        const get = (name: string) => headers.find((h: any) => h.name === name)?.value || "";

        const labelNames = (full.labelIds || [])
          .map((id: string) => labelIdToName[id])
          .filter(Boolean);

        return {
          id: msg.id,
          threadId: full.threadId,
          subject: get("Subject"),
          sender: get("From"),
          body: extractBody(full.payload).slice(0, 3000),
          receivedAt: new Date(parseInt(full.internalDate)),
          labels: labelNames,
        } as VeilleEmail;
      })
    );
    emails.push(...results);
  }

  return emails;
}

async function markEmailsAsProcessed(accessToken: string, emails: VeilleEmail[]): Promise<void> {
  const userLabels = await fetchUserLabels(accessToken);
  const traiteLabelId = await getOrCreateLabel(accessToken, "Veille/IA-Traité", userLabels);
  if (!traiteLabelId) {
    console.error("Could not get/create Veille/IA-Traité label");
    return;
  }

  for (const email of emails) {
    try {
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/modify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ addLabelIds: [traiteLabelId] }),
      });
    } catch (e) {
      console.error(`Failed to mark ${email.id} as processed:`, e);
    }
  }
}

async function sendDigestEmail(
  accessToken: string,
  digestResult: DigestResult,
  weekStart: Date
): Promise<void> {
  const to = "laurent@start-academy.fr";
  const subject = `📰 Digest Veille IA — Semaine du ${weekStart.toLocaleDateString("fr-FR")}`;

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #1a1a1a; }
  h1 { color: #1a1a1a; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  h2 { color: #374151; margin-top: 28px; }
  .score { display: inline-block; background: #f3f4f6; padding: 2px 8px; border-radius: 12px; font-size: 13px; }
  .actu { background: #f9fafb; border-left: 3px solid #6366f1; padding: 12px 16px; margin: 12px 0; border-radius: 4px; }
  .why { color: #6366f1; font-style: italic; font-size: 14px; margin-top: 6px; }
  .tag { display: inline-block; background: #e0e7ff; color: #4338ca; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin: 2px; }
  footer { color: #9ca3af; font-size: 12px; margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
</style></head>
<body>
${digestResult.html}
<footer>Généré par Laurens OS · weekly-ai-digest · Coût : ~$${digestResult.cost_usd.toFixed(3)}</footer>
</body>
</html>`;

  // Encode le subject en RFC 2047 pour supporter les emojis et accents
  const subjectEncoded = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;

  const rawMessage = [
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlBody,
  ].join("\r\n");

  const bytes = new TextEncoder().encode(rawMessage);
  const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`sendDigestEmail failed: ${JSON.stringify(data.error)}`);
}

// ============================================================
// VECTORISATION & CLUSTERING
// ============================================================

function isRundownSource(sender: string): boolean {
  return sender.toLowerCase().includes("therundown.ai");
}

function getBodyForLLM(email: VeilleEmail): string {
  const limit = isRundownSource(email.sender) ? 3000 : 1500;
  return email.body.slice(0, limit);
}

async function vectorizeEmails(
  emails: VeilleEmail[]
): Promise<Array<VeilleEmail & { embedding: number[] }>> {
  const inputs = emails.map((e) => `${e.subject}\n\n${e.body.slice(0, 1500)}`);

  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: inputs }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Vectorization failed: ${JSON.stringify(data.error)}`);

  return emails.map((email, i) => ({
    ...email,
    embedding: data.data[i].embedding as number[],
  }));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clusterSimilarEmails(
  emails: Array<VeilleEmail & { embedding: number[] }>,
  threshold: number
): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  for (const email of emails) {
    if (assigned.has(email.id)) continue;

    const cluster: Cluster = { representative: email, mentions: [], similarity: 1 };
    assigned.add(email.id);

    for (const other of emails) {
      if (assigned.has(other.id)) continue;
      const sim = cosineSimilarity(email.embedding, other.embedding);
      if (sim > threshold) {
        cluster.mentions.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  // Prioriser les clusters Rundown en tête (LLM accorde plus d'attention aux premiers éléments)
  clusters.sort((a, b) => {
    const aHasRundown = isRundownSource(a.representative.sender) || a.mentions.some((m) => isRundownSource(m.sender));
    const bHasRundown = isRundownSource(b.representative.sender) || b.mentions.some((m) => isRundownSource(m.sender));
    if (aHasRundown && !bHasRundown) return -1;
    if (!aHasRundown && bHasRundown) return 1;
    return 0;
  });

  return clusters;
}

// ============================================================
// GÉNÉRATION DU DIGEST (Claude Haiku 4.5)
// ============================================================

function markdownToSimpleHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[hul])/gm, "")
    .replace(/^(.+)$/gm, (line) =>
      line.startsWith("<") ? line : `<p>${line}</p>`
    );
}

async function generateDigest(
  clusters: Cluster[],
  totalEmails: number
): Promise<DigestResult> {
  const clustersText = clusters.map((c, i) => {
    const sources = [c.representative, ...c.mentions]
      .map((e) => e.sender.replace(/.*<(.+)>/, "$1").split("@")[1] || e.sender)
      .filter((v, idx, arr) => arr.indexOf(v) === idx);

    return `
=== Cluster ${i + 1} (${1 + c.mentions.length} email${c.mentions.length > 0 ? "s" : ""}, sources: ${sources.join(", ")}) ===
Sujet: ${c.representative.subject}
Expéditeur: ${c.representative.sender}
Labels: ${c.representative.labels.filter((l) => l.startsWith("Veille/")).join(", ")}
Contenu: ${getBodyForLLM(c.representative)}
${c.mentions.length > 0 ? `Aussi mentionné par: ${c.mentions.map((m) => m.sender).join(", ")}` : ""}`;
  }).join("\n");

  const prompt = `Tu es l'analyste veille IA de Laurent MARX. Laurent dirige Start Academy (organisme de formation certifié Qualiopi spécialisé dans la formation IA pour les professionnels de l'immobilier). Il développe aussi des outils en Rust (claw-code) et construit Laurens OS (un double numérique personnel). Son angle business unique : IA appliquée à l'immobilier.

Tu vas recevoir ${clusters.length} clusters d'actualités IA agrégées depuis ${totalEmails} emails de newsletters reçus cette semaine. Certains clusters regroupent plusieurs sources qui parlent de la même news.

Ta mission : produire un digest hebdomadaire ULTRA PERTINENT pour Laurent.

## Section Rundown AI (PRIORITAIRE)

The Rundown AI est la source de veille préférée de Laurent. C'est une newsletter quotidienne qui éditorialise déjà l'actualité IA. Elle mérite un traitement spécial :
- Profondeur : pour les actus venant de Rundown, développe plus que pour les autres. Là où une autre source mérite 2-3 lignes, Rundown mérite 4-8 lignes selon la richesse de l'info.
- Nombre d'actus : laisse-toi guider par la richesse réelle de la semaine. Si Rundown a couvert 3 grosses actus, traites-en 3. Si la semaine a été dense avec 6-7 sujets marquants, traites-en jusqu'à 8. Pas de format figé.
- Synthèse : termine la section par 1 paragraphe qui répond à "qu'est-ce que Rundown a raconté cette semaine en gros ?" — utile pour Laurent qui peut lire ça en 30 secondes.
- Ton : factuel, dense, direct. Pas de "il est intéressant de noter que". Du concret.

## Clusters à analyser

${clustersText}

## Format de sortie REQUIS

Tu réponds avec UNIQUEMENT du JSON valide, rien d'autre, ce format exact :

{
  "themes": ["theme1", "theme2", "theme3"],
  "top_3_actus": [
    {
      "titre": "Titre clair de l'actu",
      "resume": "2-3 phrases de résumé factuel",
      "sources": ["Source1", "Source2"],
      "score_pertinence": 8,
      "pourquoi_laurent": "En 1 phrase : pourquoi ça concerne Laurent spécifiquement"
    }
  ],
  "opportunites_formation": [
    {
      "news": "L'actu déclencheuse",
      "angle": "Angle de formation Start Academy en 2 lignes max"
    }
  ],
  "outils_a_tester": [
    {
      "name": "Nom de l'outil",
      "why": "En 1 phrase : pourquoi Laurent devrait le tester"
    }
  ],
  "tendances_de_fond": ["tendance1", "tendance2"],
  "rundown_focus": {
    "actus": [
      {
        "titre": "Titre actu Rundown",
        "resume_developpe": "Résumé approfondi en 4-8 lignes selon la richesse de l'info",
        "pourquoi_laurent": "Pourquoi ça concerne Laurent en 1-2 phrases"
      }
    ],
    "synthese_semaine": "1 paragraphe de synthèse globale de ce que Rundown a couvert cette semaine"
  },
  "score_pertinence_moyen": 7.2
}

Règles strictes :
- Score pertinence : 0-10 où 10 = concerne directement Start Academy / IA-immo / dev Rust
- top_3_actus : trier par score décroissant, mettre moins de 3 si seulement 1-2 valent la peine
- opportunites_formation : seulement les vraies opportunités business, pas des généralités
- outils_a_tester : seulement 1-2, les plus pertinents pour Laurent
- rundown_focus : si aucun email Rundown cette semaine, mettre null
- Tu peux écarter des clusters non pertinents, ne force rien
- IMPORTANT : toutes les valeurs string doivent être sur une seule ligne, pas de retours à la ligne dans les strings JSON`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 4000,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`);

  const content = data.choices?.[0]?.message?.content || "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch?.[0] || content);

  const cost_tokens = (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);
  // Haiku 4.5 : 1$ input / 5$ output par 1M tokens
  const cost_usd = ((data.usage?.prompt_tokens || 0) * 1 + (data.usage?.completion_tokens || 0) * 5) / 1_000_000;

  const top3: DigestResult["top3"] = parsed.top_3_actus || [];
  const opportunites: DigestResult["opportunites_formation"] = parsed.opportunites_formation || [];
  const outils: DigestResult["outils_a_tester"] = parsed.outils_a_tester || [];
  const tendances: string[] = parsed.tendances_de_fond || [];
  const rundown: DigestResult["rundown_focus"] = parsed.rundown_focus || null;

  // Génération du markdown en TypeScript (évite le JSON malformé du LLM)
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  let md = `# 📰 Digest Veille IA — ${dateStr}\n\n`;
  md += `${totalEmails} emails analysés · ${clusters.length} sujets distincts · score pertinence moyen : **${parsed.score_pertinence_moyen}/10**\n\n`;

  md += `## 🔥 Top Actus\n\n`;
  for (const a of top3) {
    md += `### ${a.titre} _(${a.score_pertinence}/10)_\n`;
    md += `${a.resume}\n`;
    md += `> **Pour toi :** ${a.pourquoi_laurent}\n`;
    if (a.sources?.length) md += `_Sources : ${a.sources.join(", ")}_\n`;
    md += "\n";
  }

  if (rundown) {
    md += `## 📡 Rundown AI cette semaine\n\n`;
    for (const a of rundown.actus || []) {
      md += `### ${a.titre}\n${a.resume_developpe}\n> ${a.pourquoi_laurent}\n\n`;
    }
    if (rundown.synthese_semaine) md += `**Synthèse :** ${rundown.synthese_semaine}\n\n`;
  }

  if (opportunites.length) {
    md += `## 💡 Opportunités Formation Start Academy\n\n`;
    for (const o of opportunites) {
      md += `- **${o.news}** → ${o.angle}\n`;
    }
    md += "\n";
  }

  if (outils.length) {
    md += `## 🛠️ Outils à Tester\n\n`;
    for (const o of outils) {
      md += `- **${o.name}** — ${o.why}\n`;
    }
    md += "\n";
  }

  if (tendances.length) {
    md += `## 📊 Tendances de Fond\n\n`;
    for (const t of tendances) md += `- ${t}\n`;
    md += "\n";
  }

  md += `---\n_Généré par Laurens OS · Coût : ~$${cost_usd.toFixed(3)}_`;

  return {
    themes: parsed.themes || [],
    markdown: md,
    html: markdownToSimpleHtml(md),
    top3,
    opportunites_formation: opportunites,
    outils_a_tester: outils,
    tendances_de_fond: tendances,
    rundown_focus: rundown,
    score_pertinence_moyen: parsed.score_pertinence_moyen || 0,
    cost_tokens,
    cost_usd,
  };
}

// ============================================================
// DISCORD
// ============================================================

async function sendDiscordVeilleIA(digestResult: DigestResult, emailCount: number): Promise<void> {
  const url = Deno.env.get("DISCORD_WEBHOOK_VEILLE_IA");
  if (!url) return;

  const top3Lines = digestResult.top3
    .map((a) => `  [${a.titre}](pertinence ${a.score_pertinence}/10)`)
    .join("\n");

  const msg = [
    `📰 **Digest Veille IA — ${emailCount} emails traités cette semaine**`,
    `🏆 **Top ${digestResult.top3.length} :**`,
    top3Lines,
    digestResult.opportunites_formation.length > 0
      ? `\n💡 **${digestResult.opportunites_formation.length} angle${digestResult.opportunites_formation.length > 1 ? "s" : ""} formation identifié${digestResult.opportunites_formation.length > 1 ? "s" : ""}**`
      : "",
    digestResult.outils_a_tester.length > 0
      ? `🧪 **${digestResult.outils_a_tester.length} outil${digestResult.outils_a_tester.length > 1 ? "s" : ""} à tester cette semaine**`
      : "",
    `📧 **Digest complet dans ta boîte Gmail**`,
  ].filter(Boolean).join("\n");

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: msg }),
  }).catch(console.error);
}

async function sendDiscordSystem(message: string): Promise<void> {
  const url = Deno.env.get("DISCORD_WEBHOOK_SYSTEME");
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  }).catch(console.error);
}

// ============================================================
// MAIN
// ============================================================

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

serve(async (req) => {
  const startTime = Date.now();
  const body = await req.json().catch(() => ({}));
  const isTest: boolean = body?.test === true;
  const daysBack: number = body?.daysBack || 7;
  const bypassTraite: boolean = body?.bypassTraite === true;

  try {
    const accessToken = await getGoogleAccessToken();

    // 1. Récupérer les emails Veille/IA-* non encore traités
    const query = VEILLE_LABELS.map((l) => `label:"${l.replace(/\//g, "-")}"`).join(" OR ");
    const traiteFilter = bypassTraite ? "" : ` -label:"Veille-IA-Traite"`;
    const fullQuery = `(${query}) newer_than:${daysBack}d${traiteFilter}`;

    const emails = await fetchEmailsWithFullContent(accessToken, fullQuery);

    if (emails.length === 0) {
      await sendDiscordSystem(`ℹ️ weekly-ai-digest — Aucun email veille IA à traiter (${daysBack} derniers jours)`);
      return new Response(JSON.stringify({ message: "No emails to digest", emails_count: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Vectoriser
    const emailsWithEmbeddings = await vectorizeEmails(emails);

    // 3. Clustering
    const clusters = clusterSimilarEmails(emailsWithEmbeddings, SIMILARITY_THRESHOLD);

    // 4. Générer le digest via Claude Sonnet
    const digestResult = await generateDigest(clusters, emails.length);

    // 5. Stocker dans ai_digests
    const weekStart = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
    const weekEnd = new Date();

    const { data: digestRecord, error: insertError } = await supabase
      .from("ai_digests")
      .insert({
        week_start: weekStart.toISOString().slice(0, 10),
        week_end: weekEnd.toISOString().slice(0, 10),
        emails_processed: emails.length,
        themes: digestResult.themes,
        digest_markdown: digestResult.markdown,
        digest_html: digestResult.html,
        opportunites_formation: digestResult.opportunites_formation,
        outils_a_tester: digestResult.outils_a_tester,
        score_pertinence_moyen: digestResult.score_pertinence_moyen,
        cost_tokens: digestResult.cost_tokens,
        cost_usd: digestResult.cost_usd,
        elapsed_ms: Date.now() - startTime,
      })
      .select()
      .single();

    if (insertError) throw new Error(`ai_digests insert: ${insertError.message}`);

    // 6. Envoyer l'email HTML (sauf mode test)
    if (!isTest) {
      await sendDigestEmail(accessToken, digestResult, weekStart);
    }

    // 7. Marquer les emails comme traités (sauf mode test)
    if (!isTest) {
      await markEmailsAsProcessed(accessToken, emails);
    }

    // 8. Discord #veille-ia — TL;DR
    await sendDiscordVeilleIA(digestResult, emails.length);

    // 9. Discord #systeme — récap
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    await sendDiscordSystem(
      `✅ weekly-ai-digest — ${emails.length} emails digérés en ${elapsed}s` +
      ` (${clusters.length} clusters, coût ~$${digestResult.cost_usd.toFixed(3)})` +
      (isTest ? " [MODE TEST — email non envoyé]" : "")
    );

    return new Response(JSON.stringify({
      success: true,
      test_mode: isTest,
      emails_processed: emails.length,
      clusters_found: clusters.length,
      score_moyen: digestResult.score_pertinence_moyen,
      cost_usd: digestResult.cost_usd,
      elapsed_ms: Date.now() - startTime,
      digest_id: digestRecord?.id,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    console.error("FATAL:", e, (e as Error).stack);
    await sendDiscordSystem(`❌ weekly-ai-digest a échoué: ${(e as Error).message}`).catch(() => {});
    return new Response(JSON.stringify({
      error: (e as Error).message,
      stack: (e as Error).stack,
    }), { status: 500 });
  }
});
