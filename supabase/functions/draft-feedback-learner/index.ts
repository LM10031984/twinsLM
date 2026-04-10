import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// DRAFT FEEDBACK LEARNER — Chantier #4
// Compare drafts générés vs emails envoyés → apprend le style Laurent
// Cron : 0 3 * * * (3h UTC quotidien)
// Note : utilise email_draft_corrections (pas corrections_log qui a un autre schéma)
// ============================================================

const SIMILARITY_THRESHOLD_FOR_LEARNING = 0.92;

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

async function vectorize(text: string): Promise<number[]> {
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({ model: "openai/text-embedding-ada-002", input: text.slice(0, 2000) }),
  });
  const data = await resp.json();
  if (!data.data?.[0]?.embedding) throw new Error(`Vectorization failed: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchSentEmailInThread(
  accessToken: string,
  threadId: string,
  draftCreatedAt: Date,
): Promise<{ body: string; sentAt: Date } | null> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const thread = await resp.json();
  if (thread.error) return null;

  for (const msg of thread.messages || []) {
    if (!(msg.labelIds || []).includes("SENT")) continue;
    const sentAt = new Date(parseInt(msg.internalDate));
    if (sentAt < draftCreatedAt) continue;
    const body = extractBody(msg.payload);
    if (body) return { body, sentAt };
  }

  return null;
}

async function calculateTextSimilarity(text1: string, text2: string): Promise<number> {
  const [emb1, emb2] = await Promise.all([
    vectorize(text1.slice(0, 2000)),
    vectorize(text2.slice(0, 2000)),
  ]);
  return cosineSimilarity(emb1, emb2);
}

async function analyzePatternsViaLLM(
  draftText: string,
  sentText: string,
): Promise<{
  summary: string;
  patterns: Array<{
    type: string;
    description: string;
    example_before: string;
    example_after: string;
  }>;
}> {
  const prompt = `Tu analyses les corrections que Laurent MARX apporte aux brouillons générés automatiquement avant envoi. Compare ces deux versions et identifie ce que Laurent a modifié.

DRAFT GÉNÉRÉ AUTOMATIQUEMENT :
${draftText.slice(0, 2000)}

VERSION RÉELLEMENT ENVOYÉE PAR LAURENT :
${sentText.slice(0, 2000)}

Identifie les patterns de correction. Catégories possibles :
- opening : changement de formule d'ouverture
- closing : changement de formule de clôture
- tone : changement de ton (plus direct, plus chaleureux, etc.)
- length : raccourci ou allongé
- formality : tutoiement vs vouvoiement, formalité
- content : ajout/suppression d'info

Réponds UNIQUEMENT en JSON valide :

{
  "summary": "Résumé en 1 phrase de ce qui a changé",
  "patterns": [
    {
      "type": "opening",
      "description": "Description courte du pattern",
      "example_before": "Court extrait du draft",
      "example_after": "Court extrait de la version envoyée"
    }
  ]
}

Si les corrections sont mineures (ponctuation, fautes), retourne patterns: [].`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 1500,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`);

  const content = data.choices?.[0]?.message?.content || "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch?.[0] || content);

  return {
    summary: parsed.summary || "Correction non analysée",
    patterns: parsed.patterns || [],
  };
}

async function upsertPattern(
  supabase: SupabaseClient,
  pattern: { type: string; description: string; example_before: string; example_after: string },
): Promise<void> {
  const { data: existing } = await supabase
    .from("style_dna_patterns")
    .select("id, occurrence_count, examples")
    .eq("pattern_type", pattern.type)
    .ilike("pattern_description", `%${pattern.description.slice(0, 30)}%`)
    .limit(1)
    .single();

  if (existing) {
    const newExamples = [
      ...(existing.examples || []),
      { before: pattern.example_before, after: pattern.example_after },
    ].slice(-10);

    await supabase
      .from("style_dna_patterns")
      .update({
        occurrence_count: existing.occurrence_count + 1,
        examples: newExamples,
        last_seen: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("style_dna_patterns").insert({
      pattern_type: pattern.type,
      pattern_description: pattern.description,
      examples: [{ before: pattern.example_before, after: pattern.example_after }],
    });
  }
}

serve(async (_req) => {
  const startTime = Date.now();
  const stats = {
    drafts_checked: 0,
    matches_found: 0,
    corrections_logged: 0,
    patterns_extracted: 0,
    errors: 0,
  };

  try {
    const accessToken = await getGoogleAccessToken();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Récupérer les drafts générés des 7 derniers jours
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: processed } = await supabase
      .from("emails_processed")
      .select("id, gmail_id, thread_id, draft_text, sender, subject, created_at")
      .not("draft_text", "is", null)
      .gte("created_at", since);

    if (!processed || processed.length === 0) {
      return new Response(JSON.stringify({ ...stats, message: "No drafts to check" }));
    }
    stats.drafts_checked = processed.length;

    for (const email of processed) {
      try {
        // 2. Vérifier si déjà loggé
        const { data: existing } = await supabase
          .from("email_draft_corrections")
          .select("id")
          .eq("thread_id", email.thread_id)
          .limit(1)
          .single();
        if (existing) continue;

        // 3. Chercher l'email envoyé sur ce thread après la génération du draft
        const sentEmail = await fetchSentEmailInThread(
          accessToken,
          email.thread_id,
          new Date(email.created_at),
        );
        if (!sentEmail) continue;
        stats.matches_found++;

        // 4. Calculer la similarité
        const similarity = await calculateTextSimilarity(email.draft_text, sentEmail.body);

        if (similarity > SIMILARITY_THRESHOLD_FOR_LEARNING) {
          // Draft accepté tel quel — logger mais pas d'apprentissage
          await supabase.from("email_draft_corrections").insert({
            email_processed_id: email.id,
            thread_id: email.thread_id,
            draft_text: email.draft_text,
            sent_text: sentEmail.body,
            similarity_score: similarity,
            diff_summary: "Draft accepté tel quel (>0.92)",
            patterns_detected: null,
          });
          continue;
        }

        // 5. Correction significative : analyse LLM
        const analysis = await analyzePatternsViaLLM(email.draft_text, sentEmail.body);

        // 6. Logger la correction
        await supabase.from("email_draft_corrections").insert({
          email_processed_id: email.id,
          thread_id: email.thread_id,
          draft_text: email.draft_text,
          sent_text: sentEmail.body,
          similarity_score: similarity,
          diff_summary: analysis.summary,
          patterns_detected: analysis.patterns,
        });
        stats.corrections_logged++;

        // 7. Vectoriser la version envoyée et l'ajouter à identity_corpus (poids x2)
        const embedding = await vectorize(sentEmail.body);
        await supabase.from("identity_corpus").insert({
          content: sentEmail.body,
          embedding,
          source: "gmail_sent_corrected",
          metadata: {
            thread_id: email.thread_id,
            similarity_to_draft: similarity,
            corrected_from_draft: true,
            weight: 2,
          },
        });

        // 8. Mettre à jour style_dna_patterns
        for (const pattern of analysis.patterns) {
          await upsertPattern(supabase, pattern);
          stats.patterns_extracted++;
        }
      } catch (e) {
        stats.errors++;
        console.error(`Error processing ${email.id}:`, e);
      }
    }

    // 9. Récap Discord #systeme
    if (stats.corrections_logged > 0) {
      const webhookSysteme = Deno.env.get("DISCORD_WEBHOOK_SYSTEME");
      if (webhookSysteme) {
        const { data: recentPatterns } = await supabase
          .from("style_dna_patterns")
          .select("pattern_type, pattern_description, occurrence_count")
          .order("occurrence_count", { ascending: false })
          .limit(5);

        const patternsText = (recentPatterns || []).length > 0
          ? `\nPatterns récents :\n${(recentPatterns || []).map((p: any) => `• ${p.pattern_description}`).join("\n")}`
          : "";

        await fetch(webhookSysteme, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🧠 **Feedback loop** — ${stats.corrections_logged} correction(s) apprise(s)\n📚 ${stats.patterns_extracted} patterns extraits${patternsText}`,
          }),
        }).catch(console.error);
      }
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
