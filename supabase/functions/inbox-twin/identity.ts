import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GmailMessage } from "./gmail.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

async function vectorize(text: string): Promise<number[]> {
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/text-embedding-ada-002",
      input: text.slice(0, 2000),
    }),
  });
  const data = await resp.json();
  if (!data.data?.[0]?.embedding) {
    throw new Error(`Vectorization failed: ${JSON.stringify(data)}`);
  }
  return data.data[0].embedding;
}

async function findSimilarEmails(
  supabase: SupabaseClient,
  embedding: number[],
  limit = 5
): Promise<{ content: string; similarity: number }[]> {
  const { data, error } = await supabase.rpc("match_identity_corpus", {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: limit,
    filter_source: "gmail_sent",
  });
  if (error) console.error("match_identity_corpus error:", error);
  return data ?? [];
}

async function callLLM(prompt: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
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
    .map(
      (e, i) =>
        `=== Exemple ${i + 1} (similarité: ${e.similarity.toFixed(2)}) ===\n${e.content.slice(0, 400)}`
    )
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
