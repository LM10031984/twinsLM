export async function getGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`OAuth refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: Date;
  labelIds: string[];
}

export async function fetchNewEmails(
  accessToken: string,
  afterTimestamp: Date
): Promise<GmailMessage[]> {
  const after = Math.floor(afterTimestamp.getTime() / 1000);
  const query = `in:inbox after:${after} -from:me`;

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await listResp.json();
  if (!list.messages?.length) return [];

  const messages: GmailMessage[] = [];
  for (const msg of list.messages) {
    const full = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then((r) => r.json());

    const headers = full.payload?.headers || [];
    const get = (name: string) => headers.find((h: any) => h.name === name)?.value || "";

    messages.push({
      id: msg.id,
      threadId: full.threadId,
      subject: get("Subject"),
      sender: get("From"),
      body: extractBody(full.payload),
      receivedAt: new Date(parseInt(full.internalDate)),
      labelIds: full.labelIds || [],
    });
  }
  return messages;
}

export async function createDraft(
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<string> {
  const message = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: { raw: encoded, ...(threadId ? { threadId } : {}) },
    }),
  });
  const data = await resp.json();
  return data.id;
}

function extractBody(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    try {
      return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      return "";
    }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}
