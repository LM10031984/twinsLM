import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// ============================================================
// LABEL RULES (synchronisé manuellement avec inbox-twin)
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
  // ========== VEILLE/IA ==========
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

// ============================================================
// MAIN
// ============================================================

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

serve(async (req) => {
  const startTime = Date.now();
  const stats = { emails_scanned: 0, emails_labeled: 0, emails_skipped: 0, errors: 0 };

  // Paramètres configurables via le body de la requête
  const body = await req.json().catch(() => ({}));
  const BATCH_SIZE = 100;
  const pageToken: string | undefined = body.pageToken || undefined;
  const scope: string = body.scope || "7d"; // ex: "7d", "14d", "30d", "90d"

  try {
    const accessToken = await getGoogleAccessToken();
    const userLabels = await fetchUserLabels(accessToken);

    // Récupère les IDs par batch avec pagination
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", `in:inbox newer_than:${scope} -from:me`);
    url.searchParams.set("maxResults", String(BATCH_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const listResp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const list = await listResp.json();
    if (list.error) throw new Error(`Gmail list failed: ${JSON.stringify(list.error)}`);
    if (!list.messages?.length) {
      return new Response(JSON.stringify({ ...stats, message: "Aucun email trouvé", done: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    stats.emails_scanned = list.messages.length;
    const backfillRows: any[] = [];

    for (const msg of list.messages) {
      try {
        const full = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        ).then((r) => r.json());

        const headers = full.payload?.headers || [];
        const get = (name: string) => headers.find((h: any) => h.name === name)?.value || "";

        const email: GmailMessage = {
          id: msg.id,
          threadId: full.threadId,
          subject: get("Subject"),
          sender: get("From"),
          body: extractBody(full.payload).slice(0, 500),
          receivedAt: new Date(parseInt(full.internalDate)),
          labelIds: full.labelIds || [],
        };

        const matchedNames = classifyWithLabels(email);
        if (!matchedNames.length) {
          stats.emails_skipped++;
          backfillRows.push({
            gmail_id: email.id,
            subject: email.subject,
            sender: email.sender,
            labels_applied: [],
            success: true,
            error: null,
            created_at: new Date().toISOString(),
          });
          continue;
        }

        const labelIds: string[] = [];
        const errors: string[] = [];
        for (const name of matchedNames) {
          const id = await getOrCreateLabel(accessToken, name, userLabels);
          if (id) labelIds.push(id);
          else errors.push(`getOrCreateLabel null: ${name}`);
        }

        let applyError: string | null = null;
        if (labelIds.length) {
          const applyResp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}/modify`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ addLabelIds: labelIds }),
            }
          );
          const applyData = await applyResp.json();
          if (applyData.error) {
            applyError = JSON.stringify(applyData.error);
            errors.push(`applyLabels: ${applyError}`);
          } else {
            stats.emails_labeled++;
          }
        }

        backfillRows.push({
          gmail_id: email.id,
          subject: email.subject,
          sender: email.sender,
          labels_applied: matchedNames,
          success: errors.length === 0,
          error: errors.length > 0 ? errors.join("; ") : null,
          created_at: new Date().toISOString(),
        });

        if (errors.length > 0) stats.errors++;

        // Pause légère pour éviter le rate limit Gmail
        await new Promise((r) => setTimeout(r, 50));

      } catch (e) {
        stats.errors++;
        console.error(`Error processing ${msg.id}:`, e);
        backfillRows.push({
          gmail_id: msg.id,
          subject: "",
          sender: "",
          labels_applied: [],
          success: false,
          error: String(e),
          created_at: new Date().toISOString(),
        });
      }
    }

    // Insert backfill_log par chunks de 100
    for (let i = 0; i < backfillRows.length; i += 100) {
      const chunk = backfillRows.slice(i, i + 100);
      const result = await supabase.from("backfill_log").insert(chunk);
      if (result?.error) console.error("backfill_log insert error:", result.error);
    }

    // Récap Discord
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
    if (webhookUrl) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `✅ **Backfill labels terminé** (${elapsed}s)\n📧 Scannés: ${stats.emails_scanned}\n🏷️ Labelisés: ${stats.emails_labeled}\n⏭️ Sans règle: ${stats.emails_skipped}\n❌ Erreurs: ${stats.errors}`,
        }),
      }).catch(console.error);
    }

    const nextPageToken = list.nextPageToken || null;
    return new Response(JSON.stringify({
      ...stats,
      elapsed_ms: Date.now() - startTime,
      scope,
      nextPageToken,
      done: !nextPageToken,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("FATAL:", e, (e as Error).stack);
    return new Response(JSON.stringify({
      error: (e as Error).message,
      stack: (e as Error).stack,
    }), { status: 500 });
  }
});
