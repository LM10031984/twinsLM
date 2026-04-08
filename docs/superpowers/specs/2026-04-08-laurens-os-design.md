# Laurens OS — Design Spec
**Date:** 2026-04-08  
**Statut:** Approuvé — prêt pour implémentation  
**Auteur:** Laurens + Claude Code

---

## Vision

Un **double numérique** (Digital Twin) qui tourne 24/7, gère les 3 activités professionnelles de Laurens, et s'améliore en continu. L'objectif : Laurens se concentre sur la stratégie, les idées, le code de haut niveau — le système gère tout le reste.

**Règle absolue :** jamais d'envoi, publication ou merge automatique. Tout passe par validation humaine.

---

## Profil utilisateur

- **Développeur** actif (repos GitHub, claw-code en Rust)
- **Dirigeant de Start Academy** — organisme de formation certifié Qualiopi
  - Programmes de formation dans Google Drive
  - Conventions et RTBL (registre apprenants) dans Drive
  - Obligations documentaires Qualiopi strictes
- **Créateur d'outils immobiliers** pour conseillers et futurs clients

---

## Architecture globale

```
SOURCES D'APPRENTISSAGE
  Gmail (500 emails envoyés)
  Google Drive (programmes, conventions, RTBL)
  GitHub (commits, PRs, code)
  Claude Code (conversations via hooks ruflo)
  Corrections des drafts (feedback loop direct)
         │
         ▼
IDENTITY CORE — Supabase
  PostgreSQL + pgvector
  style_dna · decisions_log · learners · programs
  conversations · drive_index · corrections_log
         │
    ┌────┴────┐
    ▼         ▼
AI ROUTER    AGENT SWARM
claw-code    ruflo hive-mind
    │              │
    └──────┬────────┘
           ▼
    Filtre identitaire : "Comme LUI l'aurait dit/fait"
           │
           ▼
  INTERFACE DE CONTRÔLE
    Discord (télécommande principale)
    Briefing Gmail matin (brouillon)
    Dashboard Vercel (vue globale)
           │
           ▼
    TOI → validation → action
```

---

## Pilier 1 — Identity Core (Supabase)

### Schéma de base de données

| Table | Contenu | Usage |
|---|---|---|
| `identity_corpus` | Tous les écrits vectorisés (pgvector) | Style matching |
| `style_dna` | Embeddings ADN communication | Génération dans ta voix |
| `decisions_log` | Chaque choix validé/corrigé + contexte | Apprentissage |
| `corrections_log` | Modifications de drafts par Laurens | Feedback loop |
| `emails_processed` | Emails traités + statut + draft généré | Déduplication |
| `learners` | Apprenants RTBL + statut parcours | LearnerAgent |
| `programs` | Programmes de formation + tarifs | AdminTwin + Prospects |
| `drive_index` | Index fichiers Drive + dernière ouverture | DriveWatcher |
| `conversations` | Sessions Claude Code (via hooks ruflo) | Contexte décisions |
| `real_estate_clients` | Conseillers + usage outils immobilier | ImmobilierTwin |
| `agent_memory` | Mémoire persistante par agent | Continuité |

### Fonctionnement pgvector
Chaque texte produit par Laurens est vectorisé et stocké.  
Quand un agent doit générer du contenu : recherche sémantique → "comment Laurens a-t-il répondu à quelque chose de similaire ?" → génère dans ce style.  
Précision croissante dans le temps.

### Edge Functions Supabase
- `gmail-webhook` : réception emails nouveaux → déclenchement InboxTwin
- `drive-sync` : sync quotidienne des fichiers Drive modifiés
- `github-events` : webhook GitHub → déclenchement CodeTwin sur PR/commit
- `correction-ingest` : chaque modification de draft stockée et apprise

---

## Pilier 2 — AI Router (claw-code)

Extension du crate `api` existant avec un nouveau crate `claw-mcp-server`.

### Routing de complexité automatique

| Niveau | Critères | Provider |
|---|---|---|
| Simple | Résumé, triage, reformulation courte | `ruvllm` (local, instantané) |
| Moyen | Draft mail, réponse standard, analyse doc | Claude Haiku |
| Complexe | Spec technique, décision stratégique, code | Claude Sonnet/Opus |

### Outils MCP exposés
- `route_task(content, context)` → routing automatique + réponse
- `generate_in_my_voice(prompt, type)` → génération filtrée par style_dna
- `search_my_memory(query)` → recherche sémantique Supabase
- `get_agent_status(agent_name)` → état d'un agent

### Filtre identitaire
Chaque appel LLM reçoit en contexte système :
- Les 5 exemples les plus similaires depuis `identity_corpus`
- Le `style_dna` actuel
- Les décisions récentes liées au contexte

---

## Pilier 3 — Agent Swarm (ruflo hive-mind)

### 7 agents spécialisés

#### 📧 InboxTwin
**Déclenchement :** Cron horaire  
**Flux :**
1. Scan Gmail nouveaux messages
2. Triage : URGENT / NEEDS REPLY / FYI / JUNK
3. Inférence labels existants depuis historique
4. Pour URGENT + NEEDS REPLY : génération draft dans la voix de Laurens
5. Stockage état dans `emails_processed` (Supabase)
6. Notification Discord avec résumé
7. Log dans `inbox_manager.log`

**Jamais d'envoi automatique.**

#### 📋 AdminTwin
**Déclenchement :** À la demande (Discord) + alertes deadline  
**Capacités :**
- Génération conventions de formation depuis RTBL + modèles Drive
- Attestations de présence, émargements pré-remplis
- Dossiers OPCO / financement
- Alerte deadlines réglementaires Qualiopi
- Maintien dossier audit Qualiopi en continu (indicateurs à jour)

#### 🎓 LearnerAgent
**Déclenchement :** Quotidien  
**Capacités :**
- Suivi parcours depuis RTBL
- Alerte retards (remise de devoirs, financement, présences)
- Drafts relances dans la voix de Laurens
- Vue consolidée dans briefing matin

#### 💻 CodeTwin
**Déclenchement :** Webhook GitHub (continu)  
**Capacités :**
- Surveillance repos actifs
- Détection régressions sur nouvelles branches
- Suggestions fixes en Rust (connaît le style claw-code)
- Review PRs avec commentaires dans le style technique de Laurens
- Génération commit messages dans son style

#### 💡 IdeaTwin + ContentTwin
**Déclenchement :** À la demande (Discord)  
**Capacités :**
- Idée brute → brief structuré + architecture + plan
- Brief → post LinkedIn (voix Laurens)
- Brief → newsletter apprenants
- Brief → update conseillers immobiliers
- Même idée, 3 formats, 3 audiences

#### 📁 DriveWatcher
**Déclenchement :** Quotidien  
**Capacités :**
- Index des 20 derniers fichiers Drive ouverts
- Résumé de l'état de chaque document (où Laurens en était)
- Dans briefing matin : "Tu travaillais sur [X] — page Y, section Z"

#### 🏠 ImmobilierTwin
**Déclenchement :** Continu + hebdomadaire  
**Capacités :**
- Veille réglementaire immobilière (alertes si changement impacte les outils)
- Onboarding automatique nouveaux conseillers
- Support niveau 1 (questions répétitives → réponse depuis base de connaissance)
- Analytics hebdo usage outils → rapport dans briefing
- Détection croisée : apprenant formation qui travaille dans l'immo → suggestion d'outils

---

## Interface de contrôle

### Discord (télécommande principale)
Canal privé `#laurens-os`.  
Exemples de commandes :
```
"emails urgents ?"
"statut apprenant Dupont ?"
"devis formation React 8 personnes PME"
"qu'est-ce que j'ai dans mon agenda cette semaine ?"
"deep work mode jusqu'à 18h"
"commits d'aujourd'hui claw-code ?"
"génère post LinkedIn sur [sujet]"
```
Validation des drafts par réaction ✅ dans Discord → placé en brouillon Gmail.

### Briefing matin (Gmail brouillon, 8h00)
```
🧠 LAURENS OS — Briefing du JJ/MM/AAAA

📧 Boîte mail
  X URGENT · Y NEEDS REPLY · Z FYI
  Drafts prêts — estimation validation : N min

📋 Formation
  · Alertes deadlines
  · Nouveaux inscrits / relances nécessaires

💻 Code
  · Régressions détectées
  · PRs à valider

🏠 Immobilier
  · Nouveaux conseillers
  · Alertes réglementaires

📁 Drive
  · Dernière session : [fichier] p.X

💡 File d'attente idées
  · N briefs structurés prêts
```

### Dashboard Vercel (web)
Vue globale de ce que le système a fait, ce qui est en attente de validation, historique des décisions.

---

## Mode "Concentration totale"
Commande Discord : `"deep work jusqu'à 18h"`  
Effet :
- Agents continuent de tourner en arrière-plan
- Aucune notification Discord
- À 18h : résumé complet de tout ce qui a été traité
- Urgences absolues uniquement (définies par Laurens)

---

## Apprentissage continu

### Feedback loop
1. Agent génère un draft
2. Laurens modifie → correction stockée dans `corrections_log`
3. Supabase met à jour les embeddings `style_dna`
4. `autopilot_learn` ruflo intègre le pattern
5. Prochain draft similaire : plus précis

### Évolution dans le temps
- Semaine 1-4 : ingestion initiale, calibration du style
- Mois 2-3 : précision 80%, réduction des corrections
- Mois 6+ : précision 95%+, le jumeau anticipe les besoins

---

## Sources d'apprentissage initiales

| Source | Volume | Méthode |
|---|---|---|
| Gmail envoyés | 500 derniers emails | Gmail MCP + vectorisation |
| Google Drive | Programmes, conventions, RTBL | Drive API + Supabase sync |
| GitHub | Commits, PRs, code commenté | GitHub webhook + ruflo |
| Claude Code | Sessions (hooks ruflo automatiques) | `hooks_session-end` → Supabase |

---

## Stack technique

| Composant | Technologie | Rôle |
|---|---|---|
| Identity Core | Supabase (PostgreSQL + pgvector) | Cerveau persistant |
| AI Router | claw-code (Rust, nouveau crate `claw-mcp-server`) | Routing intelligent |
| LLM local | ruvllm (ruflo) | Tâches simples, instantané |
| Agent Swarm | ruflo hive-mind | 7 agents spécialisés |
| Mémoire agents | ruflo agentdb | Continuité entre sessions |
| Apprentissage | ruflo autopilot + neural | Amélioration continue |
| Email | Gmail MCP | Lecture + brouillons |
| Agenda | Google Calendar MCP | Contexte temporel |
| Télécommande | Discord bot (ruflo workflow) | Pilotage à distance |
| Dashboard | Vercel | Vue globale |
| Scheduling | ruflo cron + CronCreate | Tâches périodiques |

---

## Les 3 phases d'implémentation

### Phase 1 — Le cerveau (fondation)
- Schéma Supabase complet + pgvector
- Ingestion initiale : Gmail + Drive + GitHub
- claw-code MCP server (`claw-mcp-server` crate)
- InboxTwin opérationnel (cron horaire)
- Discord bot basique (commandes email)
- Briefing matin automatique

### Phase 2 — Les agents
- AdminTwin Qualiopi complet
- LearnerAgent + DriveWatcher
- CodeTwin (webhook GitHub)
- IdeaTwin + ContentTwin
- ImmobilierTwin (veille + onboarding)
- Discord bot complet (toutes commandes)

### Phase 3 — L'intelligence
- Feedback loop corrections → Supabase
- autopilot ruflo : prédiction besoins
- Mode "concentration totale"
- Dashboard Vercel
- Croisement données (formation × immobilier)

---

## Règles invariables

1. **Jamais d'envoi automatique** — email, message, publication
2. **Jamais de merge/push automatique** — code
3. **Jamais de modification de données apprenants** sans validation
4. **Toujours une trace** — chaque action loggée dans Supabase
5. **Dégradation gracieuse** — si un agent échoue, les autres continuent

---

## Potentiel long terme

Ce système construit pour Laurens peut être packageé en produit SaaS pour :
- Autres OFs Qualiopi (admin automatisée)
- Créateurs d'outils immobiliers
- Développeurs-entrepreneurs multi-casquettes

Laurens est le premier utilisateur d'un produit qu'il pourrait vendre.
