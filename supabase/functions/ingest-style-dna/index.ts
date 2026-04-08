import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function getAccessToken(): Promise<string> {
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
  if (!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    try {
      return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } catch { return ""; }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}

async function fetchSentEmails(token: string, max = 500) {
  const list = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());

  if (!list.messages?.length) return [];
  const emails = [];

  for (const msg of list.messages) {
    const full = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    const headers = full.payload?.headers ?? [];
    const get = (n: string) => headers.find((h: any) => h.name === n)?.value ?? "";
    const body = extractBody(full.payload);
    if (body.length > 30) {
      emails.push({ id: msg.id, subject: get("Subject"), to: get("To"), body });
    }
  }
  return emails;
}

async function vectorize(text: string): Promise<number[]> {
  const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`,
    },
    body: JSON.stringify({
      model: "openai/text-embedding-ada-002",
      input: text.slice(0, 2000),
    }),
  });
  const data = await resp.json();
  if (!data.data?.[0]?.embedding) throw new Error(`Embedding failed: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

serve(async () => {
  try {
    const token = await getAccessToken();
    const emails = await fetchSentEmails(token, 500);

    let ingested = 0;
    const embeddings: number[][] = [];

    for (const email of emails) {
      const content = `Sujet: ${email.subject}\nÀ: ${email.to}\n\n${email.body}`;
      const embedding = await vectorize(content);
      embeddings.push(embedding);

      // identity_corpus has no source_id column and no unique constraint on (source, source_id)
      // Use plain insert; metadata stores the gmail message id for traceability
      const { error } = await supabase.from("identity_corpus").insert({
        source: "gmail_sent",
        content,
        embedding,
        metadata: { source_id: email.id, subject: email.subject, to: email.to },
      });

      if (!error) ingested++;
    }

    // Compute centroid and store in style_dna
    // style_dna has no unique constraint on dimension — delete existing row first then insert
    if (embeddings.length > 0) {
      const dims = embeddings[0].length;
      const centroid = new Array(dims).fill(0);
      for (const emb of embeddings) {
        for (let i = 0; i < dims; i++) centroid[i] += emb[i] / embeddings.length;
      }

      // Delete old centroid for this dimension, then insert fresh
      await supabase.from("style_dna").delete().eq("dimension", "email_centroid");

      await supabase.from("style_dna").insert({
        dimension: "email_centroid",
        embedding: centroid,
        sample_count: ingested,
        metadata: {
          source: "gmail_sent",
          sample_emails: ingested,
          computed_at: new Date().toISOString(),
        },
      });
    }

    // Log in decisions_log — schema uses: agent, context, decision, outcome, metadata
    await supabase.from("decisions_log").insert({
      agent: "ingest_style_dna",
      context: `${emails.length} sent emails fetched from Gmail`,
      decision: `Vectorize ${emails.length} emails into identity_corpus and compute style centroid`,
      outcome: `${ingested} emails vectorized; email_centroid stored in style_dna`,
      metadata: { total: emails.length, ingested },
    });

    return new Response(JSON.stringify({ ingested, total: emails.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
