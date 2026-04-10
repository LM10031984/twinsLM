// ============================================================
// PATCH CHANTIER #3 — Détection invitations Calendar
// À APPLIQUER dans inbox-twin/index.ts APRÈS validation de #1
//
// 1. Ajouter ces types et fonctions dans la section GOOGLE CALENDAR CLIENT
// 2. Appeler detectCalendarInvite + sendDiscordCalendarInvite
//    dans le main loop, AVANT la classification labels
//
// Contexte d'insertion dans le main loop (chercher "Détection invitation") :
//   const { category, reason } = triageEmail(email);
//   results[category]++;
//
//   // >>> INSÉRER ICI <<<
//   const invite = detectCalendarInvite(email);
//   if (invite.isInvite) {
//     await sendDiscordCalendarInvite(invite);
//   }
//   // >>> FIN INSERTION <<<
//
//   const decisionId = await logDecision(supabase, { ... });
// ============================================================

interface CalendarInvite {
  isInvite: boolean;
  type: "new" | "update" | "cancel";
  title?: string;
  startDateTime?: string;
  endDateTime?: string;
  location?: string;
  organizer?: string;
  meetUrl?: string;
}

function detectCalendarInvite(email: GmailMessage): CalendarInvite {
  const subjectLower = email.subject.toLowerCase();

  let type: "new" | "update" | "cancel" | null = null;
  if (subjectLower.startsWith("invitation:") || subjectLower.includes("invitation:")) {
    type = "new";
  } else if (
    subjectLower.startsWith("invitation mise à jour:") ||
    subjectLower.includes("updated invitation")
  ) {
    type = "update";
  } else if (
    subjectLower.includes("événement annulé") ||
    subjectLower.includes("canceled event")
  ) {
    type = "cancel";
  }

  if (!type) return { isInvite: false, type: "new" };

  let title = email.subject
    .replace(/^(invitation|invitation mise à jour|événement annulé):\s*/i, "")
    .replace(/\s*-\s*\w+\.\s+\d+\s+\w+\.\s+\d+.*$/, "")
    .trim();

  const dateMatch = email.subject.match(
    /(\w+\.\s+\d+\s+\w+\.\s+\d{4})\s+(\d{1,2}:\d{2}(?:am|pm)?)\s*-\s*(\d{1,2}:\d{2}(?:am|pm)?)/i,
  );
  const startDateTime = dateMatch ? `${dateMatch[1]} ${dateMatch[2]}` : undefined;
  const endDateTime = dateMatch ? `${dateMatch[1]} ${dateMatch[3]}` : undefined;

  const locationMatch = email.body.match(/(?:lieu|where|location)\s*:\s*([^\n]+)/i);
  const location = locationMatch ? locationMatch[1].trim().slice(0, 100) : undefined;

  const meetMatch = email.body.match(/(https:\/\/meet\.google\.com\/[a-z-]+)/i);
  const meetUrl = meetMatch ? meetMatch[1] : undefined;

  return {
    isInvite: true,
    type,
    title,
    startDateTime,
    endDateTime,
    location,
    organizer: email.sender,
    meetUrl,
  };
}

async function sendDiscordCalendarInvite(invite: CalendarInvite): Promise<void> {
  const webhookBriefs = Deno.env.get("DISCORD_WEBHOOK_BRIEFS");
  if (!webhookBriefs) return;

  let icon = "📅";
  let label = "Nouvelle invitation";
  if (invite.type === "update") { icon = "🔄"; label = "Invitation mise à jour"; }
  if (invite.type === "cancel") { icon = "❌"; label = "Événement annulé"; }

  let content = `${icon} **${label}**\n`;
  content += `**${invite.title || "(Sans titre)"}**\n`;
  if (invite.startDateTime) {
    content += `🕐 ${invite.startDateTime}${invite.endDateTime ? ` → ${invite.endDateTime}` : ""}\n`;
  }
  if (invite.location) content += `📍 ${invite.location}\n`;
  if (invite.meetUrl) content += `💻 ${invite.meetUrl}\n`;
  if (invite.organizer) content += `👤 De ${cleanSender(invite.organizer)}\n`;

  await fetch(webhookBriefs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: truncate(content) }),
  }).catch(console.error);
}
