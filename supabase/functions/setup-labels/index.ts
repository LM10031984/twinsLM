import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// TAXONOMIE COMPLÈTE — 30 labels à maintenir
// ============================================================

const LABEL_TAXONOMY = [
  "Start Academy/Interne",
  "Start Academy/Catalogue",
  "Start Academy/Coaching",
  "Formation/OPCO",
  "Formation/Qualiopi",
  "Formation/Apprenants",
  "Formation/Programmes",
  "Immobilier/Nestenn",
  "Immobilier/Agences",
  "Immobilier/Coaching-Individuel",
  "Immobilier/Veille-Alertes",
  "Banque/Finance",
  "Admin/Signatures",
  "Admin/Factures",
  "Business/Matériel",
  "Business/Assurance",
  "Business/Prestataires",
  "Veille/IA-Newsletters",
  "Veille/IA-Outils",
  "Veille/IA-LLMs-Labs",
  "Veille/IA-Formations",
  "Veille/IA-Immo",
  "Veille/IA-Events",
  "Dev/GitHub",
  "Dev/Infra",
  "Dev/Outils-IA",
  "Notifications/Google",
  "Notifications/Meetings",
  "Notifications/Apps",
  "📬 Laurens OS",
];

// Labels à renommer : { from: ancienNom, to: nouveauNom }
const LABEL_RENAMES: { from: string; to: string }[] = [
  { from: "Veille/Qualiopi", to: "Formation/Qualiopi" },
  { from: "Start Academy", to: "Start Academy/Interne" },
  { from: "Veille/IA", to: "Veille/IA-Newsletters" },
];

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

async function listGmailLabels(accessToken: string): Promise<{ id: string; name: string }[]> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (data.error) throw new Error(`listLabels failed: ${JSON.stringify(data.error)}`);
  return (data.labels ?? []).filter((l: any) => l.type === "user");
}

async function renameLabel(accessToken: string, labelId: string, newName: string): Promise<void> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`renameLabel failed for "${newName}": ${JSON.stringify(data.error)}`);
}

async function createLabel(accessToken: string, name: string): Promise<string> {
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`createLabel failed for "${name}": ${JSON.stringify(data.error)}`);
  return data.id;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

serve(async (_req) => {
  const report = { renamed: [] as string[], created: [] as string[], unchanged: [] as string[], errors: [] as string[] };

  try {
    const accessToken = await getGoogleAccessToken();
    let existingLabels = await listGmailLabels(accessToken);

    // 1. Renommages
    for (const { from, to } of LABEL_RENAMES) {
      const existing = existingLabels.find((l) => l.name.toLowerCase() === from.toLowerCase());
      if (!existing) {
        report.unchanged.push(`RENAME SKIP (not found): ${from}`);
        continue;
      }
      // Si le label cible existe déjà, pas besoin de renommer
      const targetExists = existingLabels.find((l) => l.name.toLowerCase() === to.toLowerCase());
      if (targetExists) {
        report.unchanged.push(`RENAME SKIP (target exists): ${from} → ${to}`);
        continue;
      }
      try {
        await renameLabel(accessToken, existing.id, to);
        report.renamed.push(`${from} → ${to}`);
        // Mettre à jour la liste locale
        existingLabels = existingLabels.map((l) => l.id === existing.id ? { ...l, name: to } : l);
      } catch (e) {
        report.errors.push(String(e));
      }
    }

    // 2. Création des labels manquants
    for (const name of LABEL_TAXONOMY) {
      const exists = existingLabels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        report.unchanged.push(name);
        continue;
      }
      try {
        const newId = await createLabel(accessToken, name);
        existingLabels.push({ id: newId, name });
        report.created.push(name);
      } catch (e) {
        report.errors.push(String(e));
      }
    }

    // 3. Log dans decisions_log
    await supabase.from("decisions_log").insert({
      agent: "label-migration",
      context: `setup-labels run — ${new Date().toISOString()}`,
      decision: "labels_migration",
      outcome: `renamed:${report.renamed.length} created:${report.created.length} unchanged:${report.unchanged.length} errors:${report.errors.length}`,
      metadata: report,
    });

    return new Response(JSON.stringify(report, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
