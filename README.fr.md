[English](README.md) | [简体中文](README.zhHans.md) | [繁体中文](README.zhHant.md) | [繁体中文香港](README.zhHantHK.md) | [Français](README.fr.md)

# @lansenger/openclaw-lansenger-channel

> 💠 Plugin de canal Lansenger (蓝信) pour OpenClaw — WebSocket en entrée, HTTP API en sortie.

Connecte OpenClaw à Lansenger — une plateforme de messagerie d'entreprise — via une connexion longue WebSocket pour la réception de messages en temps réel et via l'API HTTP pour l'envoi de messages.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)

## Fonctionnalités

- **Messagerie en temps réel** via connexion longue WebSocket
- **Support multi-bot** — lier plusieurs bots Lansenger à différents agents OpenClaw
- **Support Markdown** utilisant le msgType `formatText` (par défaut)
- **Fichiers/Images/Vocaux** via le msgType `text` avec upload de médias
- **i18nAppCard** — type de carte 5 langues (zhHans, zhHant, zhHantHK, en, fr). Réservé pour usage futur ; ne supporte PAS les mises à jour dynamiques ni headStatusInfo
- **appCard (approbation)** — cartes d'approbation avec `isDynamic=true` + `headStatusInfo`. Ne supporte PAS le multilingue ; utilise du texte bilingue (ex. "Pending / 待审批")
- **DynamicMsg appCard** — format de mise à jour de statut : `appCardUpdateMsg` + `isLastUpdate` + `headStatusInfo` pour les changements d'état d'approbation
- **Détection de langue** — détection automatique de la langue de l'utilisateur pour des réponses localisées
- **Routage des messages de groupe** — détection automatique et routage vers les API groupe/privé
- **@Mentions** — support @tout et @utilisateurs spécifiques dans les chats de groupe
- **Traitement des médias entrants** — téléchargement d'images/fichiers/vocaux, détection d'extension, chemins de fichiers pour l'agent
- **Révocation de messages** — révoquer les messages précédemment envoyés
- **Démarrage automatique** — la passerelle connecte automatiquement tous les comptes de bots configurés au démarrage
- **Zéro modification du core** — mode plugin pur, `git diff HEAD` reste INTACT

## Matrice de capacités des types de messages

| msgType     | Markdown | @mention | Pièces jointes |
|-------------|----------|----------|-----------------|
| `text`      | ✗        | ✓        | ✓               |
| `formatText`| ✓        | ✗        | ✗               |

**Stratégie par défaut** : utiliser `formatText` en priorité pour les réponses Markdown. Revenir à `text` pour les pièces jointes.

## Installation rapide

### Via npm (recommandé)

```bash
npm install -g @lansenger/openclaw-lansenger-channel
openclaw plugins enable lansenger
```

### Installation manuelle

```bash
cd ~/.openclaw/npm
npm install @lansenger/openclaw-lansenger-channel
openclaw plugins enable lansenger
openclaw gateway restart
```

### Installation de développement (lien local)

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw plugins enable lansenger
openclaw gateway restart
```

## Configuration

### Variables d'environnement requises

Ajoutez ces variables à `~/.openclaw/.env` ou à votre environnement :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `LANSENGER_APP_ID` | App ID du bot personnel | `2285568-10117376` |
| `LANSENGER_APP_SECRET` | App Secret du bot personnel | `57E718CA1CAC20F2...` |
| `LANSENGER_API_GATEWAY_URL` | URL de la passerelle API Lansenger (remplacement) | `https://open.e.lanxin.cn/open/apigw` |

### Obtenir les identifiants

**Client Lansenger (desktop)** → **Contacts** → **Bots** → **Bots personnels** → cliquer sur l'icône **ℹ️**

> ⚠️ **Le client mobile ne permet pas de voir les identifiants.** Utilisez uniquement le client desktop.

### Configuration optionnelle

```json
{
  "channels": {
    "lansenger": {
      "appId": "2285568-10117376",
      "appSecret": "your-secret",
      "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw",
      "homeChannel": "lansenger",
      "enabled": true,
      "allowFrom": ["2285568-xxx"],
      "dmSecurity": "allowlist",
      "accounts": {
        "2285568-10117376": {
          "appId": "2285568-10117376",
          "appSecret": "...",
          "agentId": "main",
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
| `homeChannel` | Canal par défaut pour le routage de l'agent | `lansenger` |
| `enabled` | Activer/désactiver le canal | `true` |
| `allowFrom` | IDs d'utilisateurs autorisés en DM | `[]` |
| `dmSecurity` | Politique DM : `allowlist`, `open`, `paired` | `allowlist` |
| `accounts` | Configuration multi-bot | — |

### Configuration multi-bot

Chaque bot peut être lié à un agent OpenClaw différent :

```json
{
  "channels": {
    "lansenger": {
      "accounts": {
        "bot1-appid": {
          "appId": "2285568-xxx",
          "appSecret": "...",
          "agentId": "main-agent",
          "apiGatewayUrl": "https://open.e.lanxin.cn/open/apigw"
        },
        "bot2-appid": {
          "appId": "524288-yyy",
          "appSecret": "...",
          "agentId": "test-agent"
        }
      }
    }
  },
  "bindings": [
    { "match": { "channel": "lansenger", "accountId": "bot1-appid" }, "agentId": "main-agent" }
  ]
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
# ou
openclaw gateway call lansenger.status
```

### Lier un bot à un agent (dynamique)

```bash
openclaw gateway call lansenger.bind '{"botId":"2285668-xxx","agentId":"main"}'
```

### Liste des liaisons

```bash
openclaw gateway call lansenger.bindings
```

### Délier un bot

```bash
openclaw gateway call lansenger.unbind '{"botId":"2285568-xxx"}'
```

## Types de messages supportés

| Type | Description | Méthode API | Direction |
|------|-------------|-------------|-----------|
| `text` | Texte brut avec @mentions et pièces jointes optionnelles | `sendText()` | Sortant |
| `formatText` | Texte au format Markdown (par défaut) | `sendFormatText()` | Sortant |
| `image` | Image avec légende optionnelle | `sendFile()` | Sortant |
| `file` | Tout fichier joint | `sendFile()` | Sortant |
| `video` | Vidéo jointe | `sendFile()` | Sortant |
| `voice` | Message vocal | `sendFile()` | Sortant |
| `linkCard` | Carte de prévisualisation de lien enrichi | `sendLinkCard()` | Sortant |
| `i18nAppCard` | Réservé (non utilisé pour approbation) ; 5 langues : zhHans, zhHant, zhHantHK, en, fr | `sendI18nAppCard()` | Sortant |
| `appCard` | Cartes d'approbation avec isDynamic + headStatusInfo | `sendAppCard()` | Sortant |
| `appArticles` | Carte multi-articles | `sendAppArticles()` | Sortant |
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

Le flux d'approbation utilise **appCard** pour l'envoi initial et **DynamicMsg appCard** pour les mises à jour de statut :

- **Envoi initial** : `msgType="appCard"` avec `isDynamic=true` + `headStatusInfo` (statut en attente, couleur ambre)
- **Mise à jour de statut** : DynamicMsg appCard via `updateCardStatus()` avec `appCardUpdateMsg` + `headStatusInfo`
- Le contenu utilise du texte bilingue (ex. "Pending / 待审批") car appCard ne supporte PAS le rendu i18n par langue

### Types de cartes Lansenger

| Type de carte | i18n | Mises à jour dynamiques | headStatusInfo | Utilisation |
|---------------|------|-------------------------|----------------|-------------|
| `i18nAppCard` | ✓ (5 langues) | ✗ | ✗ | Réservé pour usage futur |
| `appCard` | ✗ | ✓ (`isDynamic=true`) | ✓ | Cartes d'approbation (envoi initial) |
| DynamicMsg `appCard` | ✗ | ✓ (`appCardUpdateMsg`) | ✓ (`isLastUpdate`) | Mises à jour de statut d'approbation |

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
│   ├── channel.test.ts # Tests du plugin de canal
│   ├── runtime.ts      # Runtime passerelle (méthodes, handler entrant)
│   └── bindings.ts     # Gestionnaire de liaisons multi-bot
├── skills/
│   └── lansenger-messaging/
│       └── SKILL.md    # Stratégie de messagerie de l'agent
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

Exécutez `lansenger.bind` pour lier le bot à un agent, ou configurez `agentId` dans la configuration du compte.

### Déconnexions WebSocket

Le plugin inclut une reconnexion automatique avec un backoff exponentiel (2s, 5s, 10s, 30s, 60s) et un heartbeat (ping toutes les 30s).

### formatText vs text

- Utilisez `formatText` pour les réponses Markdown (par défaut)
- Utilisez `text` pour les @mentions ou pièces jointes
- Pour les deux, envoyez deux messages distincts

### Échec de mise à jour dynamique de carte

Les mises à jour dynamiques utilisent `msgType="appCard"` (PAS i18nAppCard). La méthode `updateCardStatus()` utilise `appCardUpdateMsg` + `headStatusInfo`.

## Licence

MIT — voir [LICENSE](LICENSE).

## Contribuer

1. Fork le dépôt
2. Créer une branche de fonctionnalité
3. Effectuer vos modifications
4. Exécuter les tests : `npx vitest run`
5. Soumettre une pull request