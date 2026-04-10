import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// CONTACT RELATIONSHIPS BUILDER — Chantier #5
// ⚠️ PRÉREQUIS : patch V2 labels déployé et validé sur #systeme
// Premier run : {"fullScan": true, "monthsBack": 6, "maxContacts": 50}
// Puis fullScan avec maxContacts: 200
// Cron hebdo : 0 4 * * 1 (lundi 4h UTC) — créer APRÈS validation du premier run
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

interface ContactProfile {
  email: string;
  displayName: string;
  threadCount: number;
  lastInteractionAt: Date;
  recentExchanges: Array<{
    subject: string;
    snippet: string;
    direction: "received" | "sent";
    date: Date;
  }>;
}

async function fetchUniqueContacts(
  accessToken: string,
  monthsBack: number,
): Promise<ContactProfile[]> {
  const query = `in:inbox newer_than:${monthsBack * 30}d -from:me`;
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500`;

  const listResp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const list = await listResp.json();
  if (list.error) throw new Error(`Gmail list error: ${JSON.stringify(list.error)}`);

  const contactsMap = new Map<string, ContactProfile>();

  for (const msg of list.messages || []) {
    try {
      const full = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((r) => r.json());

      const headers = full.payload?.headers || [];
      const fromHeader = headers.find((h: any) => h.name === "From")?.value || "";
      const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
      const snippet = full.snippet || "";
      const date = new Date(parseInt(full.internalDate));

      const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
      const email = ((emailMatch[1] || fromHeader) as string).toLowerCase().trim();
      const displayName = fromHeader.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || email;

      if (!email.includes("@")) continue;

      const existing = contactsMap.get(email);
      if (existing) {
        existing.threadCount++;
        if (date > existing.lastInteractionAt) existing.lastInteractionAt = date;
        if (existing.recentExchanges.length < 5) {
          existing.recentExchanges.push({ subject, snippet, direction: "received", date });
        }
      } else {
        contactsMap.set(email, {
          email,
          displayName,
          threadCount: 1,
          lastInteractionAt: date,
          recentExchanges: [{ subject, snippet, direction: "received", date }],
        });
      }

      await new Promise((r) => setTimeout(r, 30));
    } catch (e) {
      console.error(`Failed to fetch metadata ${msg.id}:`, e);
    }
  }

  return Array.from(contactsMap.values());
}

async function classifyContactViaLLM(contact: ContactProfile): Promise<{
  type: string;
  organization: string | null;
  suggested_labels: string[];
  confidence: number;
  reasoning: string;
}> {
  const exchangesText = contact.recentExchanges
    .map(
      (e, i) =>
        `${i + 1}. [${e.date.toISOString().slice(0, 10)}] ${e.subject}\n   ${e.snippet.slice(0, 150)}`,
    )
    .join("\n");

  const prompt = `Tu classifies les relations professionnelles de Laurent MARX, dirigeant de Start Academy (organisme de formation IA pour pros de l'immo).

Contexte sur Laurent :
- Forme des agents et dirigeants immobiliers à l'IA
- Coache individuellement quelques personnes (relation longue durée, envois de "CR de coaching" réguliers)
- A des clients récurrents (entreprises où il fait de la formation régulière, ex: ConceptPatrimoine)
- A des prospects (premiers contacts, demandes d'info)
- A une équipe interne @start-academy.fr (Julien, Jean-Guy, Nicolas, Angélique)
- A des fournisseurs/admin (banque, signatures, factures)

CONTACT À CLASSIFIER :
Email : ${contact.email}
Nom affiché : ${contact.displayName}
Nombre de threads : ${contact.threadCount}
Dernière interaction : ${contact.lastInteractionAt.toISOString().slice(0, 10)}

DERNIERS ÉCHANGES :
${exchangesText}

CATÉGORIES POSSIBLES :
- coaching_individual : coaché individuel récurrent (CR de coaching, relation longue durée)
- recurring_client : entreprise cliente récurrente (formations multiples)
- prospect : premier contact, demande d'info, pas encore client
- vendor : fournisseur, prestataire (banque, dev, hébergement)
- internal_team : équipe interne Start Academy
- admin : signatures, factures, notifications administratives
- one_shot : contact ponctuel sans relation suivie

LABELS SUGGÉRÉS DISPONIBLES :
- Coaching/Individuel, Coaching/Équipe
- Client/ConceptPatrimoine (et autres clients récurrents)
- Start Academy/Interne
- Immobilier/Nestenn, Immobilier/Agences
- Business/Prestataires, Business/Assurance, Business/Matériel
- Banque/Finance, Admin/Signatures, Admin/Factures
- Veille/IA-* (différents sous-labels)

Réponds UNIQUEMENT en JSON :

{
  "type": "coaching_individual",
  "organization": "Nom de l'orga si pertinent ou null",
  "suggested_labels": ["Label1", "Label2"],
  "confidence": 0.85,
  "reasoning": "1-2 phrases d'explication"
}

Confidence : 1.0=certitude, 0.7-0.9=haute confiance, 0.4-0.7=ambiguité, <0.4=très incertain`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 800,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`);

  const content = data.choices?.[0]?.message?.content || "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch?.[0] || content);
}

serve(async (req) => {
  const startTime = Date.now();
  const body = await req.json().catch(() => ({}));
  const isFullScan = body?.fullScan === true;
  const monthsBack = body?.monthsBack || 6;
  const maxContacts = body?.maxContacts || 200;

  const stats = {
    contacts_scanned: 0,
    contacts_classified: 0,
    high_confidence: 0,
    needs_review: 0,
    errors: 0,
  };

  try {
    const accessToken = await getGoogleAccessToken();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const contacts = await fetchUniqueContacts(accessToken, monthsBack);
    stats.contacts_scanned = contacts.length;

    contacts.sort((a, b) => b.threadCount - a.threadCount);
    const toProcess = contacts.slice(0, maxContacts);

    const needsReviewList: any[] = [];

    for (const contact of toProcess) {
      try {
        const { data: existing } = await supabase
          .from("contact_relationships")
          .select("id, validated_by_human")
          .eq("email_address", contact.email)
          .single();

        if (existing?.validated_by_human && !isFullScan) continue;

        const classification = await classifyContactViaLLM(contact);
        stats.contacts_classified++;

        await supabase.from("contact_relationships").upsert(
          {
            email_address: contact.email,
            display_name: contact.displayName,
            relationship_type: classification.type,
            organization: classification.organization,
            suggested_labels: classification.suggested_labels,
            confidence: classification.confidence,
            thread_count: contact.threadCount,
            last_interaction_at: contact.lastInteractionAt.toISOString(),
            reasoning: classification.reasoning,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "email_address" },
        );

        if (classification.confidence >= 0.7) {
          stats.high_confidence++;
        } else {
          stats.needs_review++;
          needsReviewList.push({
            email: contact.email,
            type: classification.type,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
          });
        }
      } catch (e) {
        stats.errors++;
        console.error(`Error classifying ${contact.email}:`, e);
      }
    }

    const webhookSysteme = Deno.env.get("DISCORD_WEBHOOK_SYSTEME");
    if (webhookSysteme) {
      let content = `🧠 **contact-relationships-builder terminé**\n` +
        `📊 ${stats.contacts_classified}/${stats.contacts_scanned} contacts classifiés\n` +
        `✅ ${stats.high_confidence} haute confiance\n` +
        `⚠️ ${stats.needs_review} à valider manuellement\n`;

      if (needsReviewList.length > 0 && needsReviewList.length <= 10) {
        content += `\n**À valider :**\n`;
        for (const item of needsReviewList.slice(0, 10)) {
          content += `• ${item.email} → ${item.type} (${(item.confidence * 100).toFixed(0)}%)\n`;
        }
        content += "\n💡 Modifie la table contact_relationships dans Supabase pour valider";
      } else if (needsReviewList.length > 10) {
        content += "\n💡 Voir Supabase pour la liste complète";
      }

      await fetch(webhookSysteme, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900) }),
      }).catch(console.error);
    }

    return new Response(JSON.stringify({ ...stats, elapsed_ms: Date.now() - startTime }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("FATAL:", e, (e as Error).stack);
    return new Response(
      JSON.stringify({ error: (e as Error).message, stack: (e as Error).stack }),
      { status: 500 },
    );
  }
});
