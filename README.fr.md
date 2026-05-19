[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger-pm/openclaw-lansenger-channel

> 💠 Plugin de canal Lansenger (蓝信) pour OpenClaw — WebSocket en entrée, HTTP API en sortie.

Connecte OpenClaw à Lansenger — une plateforme de messagerie d'entreprise — via une connexion longue WebSocket pour la réception de messages en temps réel et via l'API HTTP pour l'envoi de messages.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## Fonctionnalités

- **Messagerie en temps réel** via connexion longue WebSocket
- **Support multi-bot** — lier plusieurs bots Lansenger à différents agents OpenClaw
- **Support Markdown** utilisant le msgType `formatText` (par défaut)
- **Fichiers/Images/Vocaux** via le msgType `text` avec upload de médias
- **Cartes d'approbation** — workflow d'approbation interactif avec mises à jour de statut en place (en attente → approuvé/refusé)
- **Détection de langue** — détection automatique de la langue de l'utilisateur pour des réponses localisées
- **Auto-routage via msgTarget** — toutes les méthodes d'envoi routent automatiquement vers les API groupe ou DM (privé) ; pas de méthodes groupe/privé séparées
- **@Mentions** — support @tout et @utilisateurs spécifiques dans les chats de groupe
- **Traitement des médias entrants** — téléchargement d'images/fichiers/vocaux, détection d'extension, chemins de fichiers pour l'agent
- **Révocation de messages** — révoquer les messages précédemment envoyés (chatType : bot ou groupe uniquement)
- **Démarrage automatique** — la passerelle connecte automatiquement tous les comptes de bots configurés au démarrage
- **Zéro modification du core** — mode plugin pur, `git diff HEAD` reste INTACT

## Matrice de capacités des types de messages

| msgType     | Markdown | @mention | Pièces jointes |
|-------------|----------|----------|-----------------|
| `text`      | ✗        | ✓        | ✓               |
| `formatText`| ✓        | ✓ (reminder)| ✗               |

**Stratégie par défaut** : utiliser `formatText` en priorité pour les réponses Markdown. Revenir à `text` pour les pièces jointes. Les deux types supportent @mention via le paramètre `reminder` — inclure « @姓名 » dans le texte pour les mentions.

## Outils de l'agent & CLI

Les outils agent sont **intégrés dans ce plugin** — ils sont toujours disponibles lorsque le canal est configuré et en cours d'exécution. La CLI est une alternative optionnelle via bash.

Les messages peuvent être envoyés via les **outils agent** (intégrés) ou les **commandes CLI** (alternative optionnelle) :

| Méthode | Installation | Utilisation |
|---------|-------------|-------------|
| **Outils agent** (intégrés) | Inclus dans `@lansenger-pm/openclaw-lansenger-channel` | `lansenger_send_file`, `lansenger_send_text`, etc. |
| Commandes CLI (optionnel) | `pipx install lansenger-cli` (`pip install lansenger-cli` comme alternative) | `lansenger message send-file`, `lansenger message send-text`, etc. |

> **Les outils agent sont toujours disponibles** lorsque le canal est configuré et la passerelle en cours d'exécution — aucun plugin séparé nécessaire. Les commandes CLI sont une alternative optionnelle pour les environnements où l'accès bash est préféré ; elles nécessitent `lansenger-cli` (Python).

| Outil | Description |
|-------|-------------|
| `lansenger_send_text` | Envoyer un message texte brut, pas de Markdown |
| `lansenger_send_format_text` | Envoyer du texte formaté Markdown avec @mentions optionnelles |
| `lansenger_send_file` | Envoyer fichier/image/video/voix (workspace ou chemin externe) |
| `lansenger_send_image_url` | Envoyer une image par URL |
| `lansenger_send_link_card` | Envoyer une carte de prévisualisation de lien enrichi |
| `lansenger_send_app_card` | Envoyer une carte interactive/approbation |
| `lansenger_send_app_articles` | Envoyer une carte multi-articles |
| `lansenger_update_dynamic_card` | Mettre à jour le statut d'une carte dynamique en place |
| `lansenger_revoke_message` | Révoquer un message précédemment envoyé |
| `lansenger_query_groups` | Rechercher les groupes disponibles |

Les outils sont aussi disponibles via CLI : `lansenger message send-text`, `lansenger message send-file`, etc.

## Installation et Configuration

### Installation recommandée

```bash
# 1. Installer le plugin de canal (inclut les outils agent)
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. Activer le plugin (si non auto-activé)
openclaw config set plugins.entries.lansenger.enabled true

# 3. Configurer le canal (assistant interactif)
openclaw channels add

# 4. Redémarrer la passerelle
openclaw gateway restart
```

> **Optionnel** : Installer `lansenger-cli` pour une alternative CLI : `pipx install lansenger-cli`.

> **Passerelle personnalisée** : pour les déploiements entreprise (ex. 奇安信), configurez `apiGatewayUrl` dans `openclaw.json` ou via les variables d'environnement après la configuration — voir [Configuration optionnelle](#configuration-optionnelle).

### Installation de développement (lien local)

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

### Obtenir les identifiants

**Lansenger Desktop** → **Contacts** → **Bots** → **Personal Bots** → cliquer sur l'icône **ℹ️**

> ⚠️ **Le client mobile ne permet PAS de voir les identifiants.** Utilisez uniquement le client desktop.

### Premier message

Après le redémarrage, le bot se connecte automatiquement via WebSocket. Envoyez un DM au bot — vous recevrez un code de pairage. Approuvez-le :

```bash
openclaw pairing approve lansenger <code>
```

## Configuration

### Variables d'environnement requises

Ajoutez ces variables à `~/.openclaw/.env` ou à votre environnement :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `LANSENGER_APP_ID` | App ID du bot personnel | `your-appid` |
| `LANSENGER_APP_SECRET` | App Secret du bot personnel | `57E718CA1CAC20F2...` |
| `LANSENGER_API_GATEWAY_URL` | URL de la passerelle API Lansenger (remplacement) | `https://open.e.lanxin.cn/open/apigw` |

Les identifiants peuvent aussi être fournis via la configuration `openclaw.json` (voir Configuration optionnelle ci-dessous). Les valeurs de configuration sont prioritaires ; les variables d'environnement sont utilisées comme repli lorsque la configuration n'est pas définie.

### Obtenir les identifiants

**Client Lansenger (desktop)** → **Contacts** → **Bots** → **Bots personnels** → cliquer sur l'icône **ℹ️**

> ⚠️ **Le client mobile ne permet pas de voir les identifiants.** Utilisez uniquement le client desktop.

### Configuration optionnelle

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw",
      "homeChannel": "2285568-xxx",
      "enabled": true,
      "allowFrom": ["your-appid"],
      "dmPolicy": "pairing",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
          "appSecret": "...",
          "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw"
        }
      }
    }
  }
}
```

| Champ | Description | Valeur par défaut |
|-------|-------------|-------------------|
| `appId` | App ID du bot personnel | — |
| `appSecret` | App Secret du bot personnel | — |
| `apiGatewayUrl` | URL de la passerelle API | `https://open.e.lanxin.cn/open/apigw` |
| `homeChannel` | Chat ID par défaut pour la livraison cron/notification | — |
| `enabled` | Activer/désactiver le canal (défaut runtime : false sans identifiants) | `true` |
| `allowFrom` | IDs d'utilisateurs autorisés en DM | `[]` |
| `dmPolicy` | Politique DM : `pairing`, `allowlist`, `open`, `disabled` | `pairing` |
| `configWrites` | Autoriser Lansenger à écrire la config en réponse aux événements du canal | `true` |
| `name` | Nom d'affichage pour ce compte | — |
| `accounts` | Configuration multi-bot | — |
| `groupPolicy` | Politique de groupe : `open` (tous les groupes), `allowlist` (groupes autorisés uniquement), `disabled` (messages de groupe désactivés) | `allowlist` |
| `groupAllowFrom` | IDs de groupes autorisés à déclencher le bot | `[]` |
| `groups` | Configuration par groupe (requireMention, enabled, allowFrom) | — |

### Configuration multi-bot

Pour ajouter plusieurs bots, utilisez `openclaw config set` avec la structure `accounts` :

```bash
# Ajouter un deuxième bot (remplacez appid/appsecret/gateway par vos valeurs)
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# Redémarrer pour appliquer
openclaw gateway restart
```

Structure de configuration résultante :

```json
{
  "channels": {
    "lansenger": {
      "appId": "your-appid-2",
      "appSecret": "...",
      "dmPolicy": "pairing",
      "accounts": {
        "your-appid-2": {
          "appId": "your-appid-2",
          "appSecret": "...",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        }
      }
    }
  }
}
```

## Utilisation

La passerelle démarre automatiquement tous les comptes configurés au démarrage. La méthode `lansenger.start` est disponible pour démarrer dynamiquement des comptes supplémentaires.

### Démarrer la passerelle (dynamique)

```bash
openclaw gateway call lansenger.start
```

### Arrêter la passerelle

```bash
openclaw gateway call lansenger.stop
```

### Vérifier le statut

```bash
openclaw channels status
# Avec probe de santé (affiche « configured » et « works ») :
openclaw channels status --probe
```

### Routage multi-agent

Utilisez `bindings` pour router les DM Lansenger ou les conversations de groupe vers différents agents (même principe que Feishu/WhatsApp/etc.) :

```json5
{
  agents: {
    list: [
      { id: "main" },
      { id: "agent-a", workspace: "/home/user/agent-a" },
    ],
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "lansenger",
        peer: { kind: "direct", id: "2285568-xxx" },
      },
    },
    {
      agentId: "agent-a",
      match: {
        channel: "lansenger",
        peer: { kind: "group", id: "group-chat-id" },
      },
    },
  ],
}
```

Champs de routage :
* `match.channel`: `"lansenger"`
* `match.peer.kind`: `"direct"` (DM) ou `"group"` (chat de groupe)
* `match.peer.id`: ID utilisateur (`2285568-xxx`) ou ID de chat de groupe

En mode mono-agent, tous les messages routent vers l'agent par défaut (`main`) automatiquement — pas de bindings nécessaires.

### Types de messages supportés

| Type | Description | Méthode API | Direction |
|------|-------------|-------------|-----------|
| `text` | Texte brut avec @mentions et pièces jointes optionnelles | `sendText()` | Sortant |
| `formatText` | Texte au format Markdown (par défaut) | `sendFormatText()` | Sortant |
| `image` | Image avec légende optionnelle | `sendFile()` | Sortant |
| `file` | Tout fichier joint | `sendFile()` | Sortant |
| `video` | Vidéo jointe | `sendFile()` | Sortant |
| `voice` | Message vocal | `sendFile()` | Sortant |
| `linkCard` | Carte de prévisualisation de lien enrichi | `sendLinkCard()` | Sortant |
| `i18nAppCard` | Réservé pour usage futur ; carte 5 langues | `sendI18nAppCard()` | Sortant |
| `appCard` | Cartes d'approbation avec mises à jour de statut | `sendAppCard()` | Sortant |
| `appArticles` | Carte multi-articles (champ : `summary`, pas `description`) | `sendAppArticles()` | Sortant |
| `position` | Message de localisation/position | — | Entrant uniquement |
| `card` | Message de carte générique | — | Entrant uniquement |
| `sticker` | Message sticker/emoji | — | Entrant uniquement |

## Traitement des médias entrants

Lorsque les utilisateurs envoient des images, vidéos, fichiers ou messages vocaux, le plugin :

1. Télécharge tous les `mediaIds` via l'API média Lansenger
2. Détecte l'extension de fichier depuis les en-têtes Content-Type/Content-Disposition (repli : octets magiques)
3. Enregistre dans des fichiers temporaires et attache les chemins à `InboundEvent.mediaPaths[]`
4. Ajoute un indice dans le texte de l'agent : « Fichiers joints sauvegardés localement — utilisez l'outil de lecture pour visualiser »

## Flux d'approbation

Le plugin supporte les cartes d'approbation :
- Les demandes d'approbation sont envoyées via **appCard** avec `isDynamic=true`
- Les mises à jour de statut (en attente → approuvé/refusé) mettent à jour la carte en place via **DynamicMsg**
- La langue détectée automatiquement détermine la langue de la carte (chinois ou anglais)
- **i18nAppCard** (5 langues) est réservé pour un usage futur et n'est pas utilisé pour l'approbation

## Notes importantes

- **Pas de chat staff** — Lansenger n'a que les chats de groupe et DM (privé) ; il n'existe pas de concept de « chat staff ».
- **Révocation chatType** — uniquement `bot` ou `group` ; pas de chatType `staff`.
- **Pas de sysMsg sur révocation** — l'API accepte `sysMsg` mais ne l'affiche pas.
- **Pas de deleteMessage** — l'API retourne l'erreur 10000 ; la suppression n'est pas disponible.
- **appArticles** — utilise le champ `summary` (pas `description`).
- **linkCard** — `description`, `iconLink`, `fromName`, `fromIconLink` sont requis (chaînes vides comme valeurs par défaut).
- **Auto-routage msgTarget** — toutes les méthodes d'envoi routent automatiquement ; pas d'appels API groupe/privé séparés.
- **URL passerelle par environnement** — e.g. `https://apigw.lx.qianxin.com` pour 奇安信, `https://open.e.lanxin.cn/open/apigw` pour Lansenger standard.
- **reminder** — champ optionnel dans formatText ; recommandé dans les chats de groupe. Inclure « @姓名 » dans le texte pour les mentions.
- **Média** — les balises `<media>` fonctionnent pour les fichiers du workspace ; pour les chemins externes, utilisez `lansenger_send_file`.
- **openclaw skill/message lansenger** — ces commandes CLI n'existent PAS ; utilisez les outils de l'agent.
- **Outils agent** — les outils agent (`lansenger_send_*`) nécessitent le plugin outils ET une injection réussie de la passerelle — si les outils ne sont pas disponibles, utilisez la CLI comme repli. Les commandes CLI (`lansenger message send-*`) nécessitent `pipx install lansenger-cli`.
- **alsoAllow** — les outils agent sont enregistrés par ce plugin de canal mais peuvent être **invisibles** sous un profil d'outils restrictif. Ajoutez `"tools": { "alsoAllow": ["group:plugins"] }` dans `openclaw.json` pour que l'agent puisse voir et utiliser les outils `lansenger_send_*`. Sans cela, les outils peuvent ne pas apparaître silencieusement dans la liste d'outils de l'agent.

## Développement

### Compilation

```bash
npm install
npx tsc
```

### Tests

```bash
npx vitest run
```

### Vérification de types

```bash
npx tsc --noEmit
```

### Structure du projet

```
openclaw-lansenger-channel/
├── src/
│   ├── client.ts       # Client API Lansenger (WS, HTTP, médias)
│   ├── channel.ts      # Plugin de canal OpenClaw
│   ├── runtime.ts      # Runtime passerelle (méthodes, handler entrant)
│   ├── tools.ts        # Définitions des outils agent (10 outils intégrés)
│   ├── setup-wizard.ts # Assistant de configuration (migration config multi-compte)
│   ├── channel.test.ts # Tests du plugin de canal
│   ├── client.test.ts  # Tests du client API
│   ├── runtime.test.ts # Tests du runtime
│   ├── tools.test.ts   # Tests des outils
│   └── setup-wizard.test.ts # Tests de l'assistant de configuration
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # Stratégie de messagerie (outils + CLI)
├── dist/               # JavaScript compilé
├── index.ts            # Point d'entrée du plugin
├── setup-entry.ts      # Point d'entrée de l'assistant de configuration
├── openclaw.plugin.json # Métadonnées du plugin & configuration GUI
├── package.json
└── tsconfig.json
```

## Dépannage

### "Le client mobile ne permet pas de voir les identifiants"

Utilisez uniquement le **client Lansenger (desktop)**. L'application mobile n'affiche pas les identifiants du bot.

### "No binding for botId"

Le routage des agents est géré par la configuration `bindings[]` d'OpenClaw — voir [Routage multi-agent](#routage-multi-agent). En mode mono-agent, aucun binding est nécessaire ; les messages routent automatiquement vers l'agent par défaut.

### Déconnexions WebSocket

Le plugin inclut une reconnexion automatique avec un backoff exponentiel (2s, 5s, 10s, 30s, 60s) et un heartbeat (ping toutes les 30s).

### formatText vs text

- Utilisez `formatText` pour les réponses Markdown (par défaut)
- Utilisez `text` pour les pièces jointes (pas de Markdown)
- Les deux types supportent @mention via `reminder` — inclure « @姓名 » dans le texte pour les mentions
- Pour Markdown ET fichier, envoyez deux messages distincts

### Échec de mise à jour dynamique de carte

Les mises à jour de statut d'approbation utilisent le format DynamicMsg appCard. La méthode `updateCardStatus()` gère cela automatiquement.

## Journal des modifications

- **v3.5.0** — Correction de la livraison en double des messages (déduplication par tour) ; suppression du suffixe UUID OpenClaw des noms de fichiers ; documentation whitelist MEDIA ; conseil alsoAllow ; corrections d'exactitude README
- **v3.3.0** — Fusion du plugin tools dans le plugin canal ; outils agent désormais intégrés (pas d'installation séparée) ; suppression des peerDependencies sur `@lansenger-pm/openclaw-lansenger-tools`
- **v3.2.10** — Alerte au démarrage si `group:plugins` absent de l'allowlist ; `configWrites` dans le schema de config canal ; plugin compagnon via `globalThis.__lansenger_channel`
- **v3.1.0** — Wizard multi-compte ; alignement dmPolicy (dmSecurity→dmPolicy + paired→pairing) ; prompts bilingues ; shouldPrompt skip steps configurés ; migration config multi-compte
- **v3.0.0** — Ajout `lansenger_send_format_text` (Markdown + @mention) ; réécriture SKILL.md ; correction headStatusInfo description+colour
- **v2.10.0** — Conversion px→pt appCard ; classification erreurs sendImageUrl ; journalisation outils
- **v2.9.0** — Adaptateur statut ; repli env vars ; uiHints chinois ; README nettoyage (5 langues)
- **v2.8.0** — Routage multi-agent OpenClaw `bindings[]` ; groupPolicy/groupAllowFrom/groups ; SKILL.md AgentSkills
- **v2.7.0** — Enregistrement outils objets simples ; état runtime client/target
- **v2.6.0** — Enregistrement inconditionnel ; suppression ghost delete_message
- **v2.5.0** — formatText reminder ; AppArticles `summary` ; revoke bot/group uniquement
- **v2.4.0** — Correction assemblage message ; corrections appArticles/linkCard
- **v2.3.0** — Suppression envoi groupe/privé legacy ; routage via msgTarget
- **v2.2.0** — Ajout 9 outils agent
- **v2.0.0** — Version initiale

## Licence

MIT — voir [LICENSE](LICENSE).

## Contribuer

1. Fork le dépôt
2. Créer une branche de fonctionnalité
3. Effectuer vos modifications
4. Exécuter les tests : `npx vitest run`
5. Soumettre une pull request