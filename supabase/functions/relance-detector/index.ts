import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// RELANCE DETECTOR — Chantier #2
// Détecte les emails envoyés sans réponse → stocke dans relances_pending
// Cron : 0 5 * * * (5h UTC, avant le brief matin de 6h)
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

// Domaines à exclure des relances
const EXCLUDE_DOMAINS = [
  "noreply", "no-reply", "donotreply",
  "@accounts.google.com",
  "@mail.app.supabase.io", "registration@vercel.com", "noreply@airtable.com",
  "adobesign.com", "docusign",
  "therundown.ai", "skool.com", "1min.ai", "heygen.com", "ollama.com",
  "logiaweb", "beehiiv.com",
  "calendar-notification@google.com", "meetings-noreply@google.com",
  "gemini-notes@google.com",
  "@email.apple.com",
];

const EXCLUDE_SUBJECT_PATTERNS = [
  "invitation:", "événement annulé", "canceled event",
  "reset your password", "reset password",
  "vous avez signé", "signature demandée",
  "weekly", "newsletter", "digest",
  "fwd:", "fw:",
];

const MIN_DAYS_SINCE_SENT = 3;
const MAX_DAYS_SINCE_SENT = 30;

interface SentEmail {
  threadId: string;
  messageId: string;
  recipient: string;
  subject: string;
  sentAt: Date;
  daysSinceSent: number;
}

function shouldExclude(email: SentEmail): boolean {
  const recipientLower = email.recipient.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  if (EXCLUDE_DOMAINS.some((d) => recipientLower.includes(d))) return true;
  if (EXCLUDE_SUBJECT_PATTERNS.some((p) => subjectLower.includes(p))) return true;
  return false;
}

async function fetchSentEmailsInWindow(
  accessToken: string,
  minDays: number,
  maxDays: number,
): Promise<SentEmail[]> {
  const query = `in:sent newer_than:${maxDays}d older_than:${minDays}d`;
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=200`;

  const listResp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const list = await listResp.json();
  if (list.error) throw new Error(`Gmail list error: ${JSON.stringify(list.error)}`);

  const messages = list.messages || [];
  const result: SentEmail[] = [];

  for (const msg of messages) {
    try {
      const full = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((r) => r.json());

      const headers = full.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

      const sentAt = new Date(parseInt(full.internalDate));
      const daysSinceSent = Math.floor((Date.now() - sentAt.getTime()) / (1000 * 3600 * 24));

      result.push({
        threadId: full.threadId,
        messageId: msg.id,
        recipient: get("To"),
        subject: get("Subject"),
        sentAt,
        daysSinceSent,
      });

      await new Promise((r) => setTimeout(r, 30));
    } catch (e) {
      console.error(`Failed to fetch ${msg.id}:`, e);
    }
  }

  return result;
}

async function threadHasReplyAfter(
  accessToken: string,
  threadId: string,
  sentAt: Date,
): Promise<boolean> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const thread = await resp.json();
  if (thread.error) return false;

  for (const m of thread.messages || []) {
    const internalDate = new Date(parseInt(m.internalDate));
    const isFromLaurent = (m.labelIds || []).includes("SENT");
    if (internalDate > sentAt && !isFromLaurent) return true;
  }

  return false;
}

serve(async (_req) => {
  const startTime = Date.now();
  const stats = {
    sent_scanned: 0,
    threads_checked: 0,
    relances_detected: 0,
    relances_already_pending: 0,
    excluded: 0,
    errors: 0,
  };

  try {
    const accessToken = await getGoogleAccessToken();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const sentEmails = await fetchSentEmailsInWindow(accessToken, MIN_DAYS_SINCE_SENT, MAX_DAYS_SINCE_SENT);
    stats.sent_scanned = sentEmails.length;

    for (const email of sentEmails) {
      try {
        if (shouldExclude(email)) {
          stats.excluded++;
          continue;
        }

        const hasReply = await threadHasReplyAfter(accessToken, email.threadId, email.sentAt);
        stats.threads_checked++;

        if (hasReply) continue;

        const { data: existing } = await supabase
          .from("relances_pending")
          .select("id")
          .eq("thread_id", email.threadId)
          .single();

        if (existing) {
          stats.relances_already_pending++;
          continue;
        }

        await supabase.from("relances_pending").insert({
          thread_id: email.threadId,
          last_message_id: email.messageId,
          recipient: email.recipient,
          subject: email.subject,
          sent_at: email.sentAt.toISOString(),
          days_since_sent: email.daysSinceSent,
        });
        stats.relances_detected++;
      } catch (e) {
        stats.errors++;
        console.error(`Error checking ${email.threadId}:`, e);
      }
    }

    const webhookSysteme = Deno.env.get("DISCORD_WEBHOOK_SYSTEME");
    if (webhookSysteme && stats.relances_detected > 0) {
      await fetch(webhookSysteme, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🔔 relance-detector — ${stats.relances_detected} nouvelle(s) relance(s) détectée(s) (${stats.threads_checked} threads scannés, ${stats.excluded} exclus)`,
        }),
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
