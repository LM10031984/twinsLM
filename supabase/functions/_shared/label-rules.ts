// ============================================================
// MODULE PARTAGÉ — Label Rules
// Importé par : swift-responder (inbox-twin), backfill-labels
// ============================================================

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  body: string;
  receivedAt: Date;
  labelIds: string[];
}

export const LABEL_RULES: { label: string; match: (e: GmailMessage) => boolean }[] = [
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
    label: "Immobilier/Coaching-Individuel",
    match: (e) => ["coaching individuel", "suivi personnalisé", "session coaching"]
      .some((s) => e.subject.toLowerCase().includes(s))
      && ["@nestenn.com", "@iadfrance.fr", "@lagenceimmo.eu", "@kwfrance.com"]
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

  // ========== VEILLE/IA (6 sous-labels) ==========
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

export function classifyWithLabels(email: GmailMessage): string[] {
  return LABEL_RULES.filter((r) => r.match(email)).map((r) => r.label);
}
