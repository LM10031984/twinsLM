import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ============================================================
// OAUTH SETUP — Utilitaire one-shot
// Génère un refresh_token Google avec les scopes Gmail + Calendar
//
// Étape 1 : GET /oauth-setup          → redirige vers Google pour autorisation
// Étape 2 : GET /oauth-setup?code=... → échange le code → affiche le refresh_token
//
// Après usage : supprimer cette fonction (données sensibles)
// ============================================================

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  // La redirect_uri doit correspondre exactement à ce qui est autorisé dans la Google Console
  // Pour une Edge Function Supabase, utilise l'URL publique de cette fonction
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth-setup`;

  // ─── ÉTAPE 2 : échange du code ──────────────────────────────
  if (code) {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenResp.json();

    if (tokens.error) {
      return new Response(
        `<html><body><h2>Erreur</h2><pre>${JSON.stringify(tokens, null, 2)}</pre></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OAuth Setup</title>
<style>body{font-family:monospace;padding:2rem;max-width:800px;margin:0 auto}
.token{background:#f0f0f0;padding:1rem;border-radius:4px;word-break:break-all;font-size:0.85rem}
.warning{color:#c00;font-weight:bold}</style></head>
<body>
<h2>✅ Nouveau refresh token généré</h2>
<p class="warning">⚠️ Copie ce token immédiatement, ferme cette page, et mets à jour le secret Supabase GOOGLE_REFRESH_TOKEN.</p>
<h3>refresh_token :</h3>
<div class="token">${tokens.refresh_token || "(pas de refresh_token — as-tu bien décoché 'accès hors ligne' dans les scopes ?)"}</div>
<h3>Scopes accordés :</h3>
<div class="token">${tokens.scope || "(inconnu)"}</div>
<br>
<h3>Étapes suivantes :</h3>
<ol>
<li>Copie le refresh_token ci-dessus</li>
<li>Va dans Supabase Dashboard → Settings → Edge Functions → Secrets</li>
<li>Met à jour <strong>GOOGLE_REFRESH_TOKEN</strong> avec cette nouvelle valeur</li>
<li>Supprime la Edge Function oauth-setup (données sensibles)</li>
<li>Reviens sur #systeme et confirme "✅ OAuth Calendar configuré"</li>
</ol>
</body></html>`;

    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ─── ÉTAPE 1 : redirection vers Google ─────────────────────
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");  // force refresh_token même si déjà autorisé

  return Response.redirect(authUrl.toString(), 302);
});
