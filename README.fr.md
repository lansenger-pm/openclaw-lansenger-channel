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

## Outils de l'agent (v2.5.1)

| Outil | Description |
|-------|-------------|
| `lansenger_send_text` | Envoyer un message text ou formatText (Markdown par défaut) |
| `lansenger_send_file` | Envoyer fichier/image/vidéo/audio (workspace ou chemin externe) |
| `lansenger_send_image_url` | Envoyer une image par URL |
| `lansenger_send_link_card` | Envoyer une carte de prévisualisation de lien |
| `lansenger_send_app_card` | Envoyer une carte interactive/approbation |
| `lansenger_send_app_articles` | Envoyer une carte multi-articles |
| `lansenger_update_dynamic_card` | Mettre à jour le statut d'une carte dynamique |
| `lansenger_revoke_message` | Révoquer un message précédemment envoyé |
| `lansenger_query_groups` | Interroger les groupes disponibles |

## Installation rapide

### Via OpenClaw CLI (recommandé)

```bash
# 1. Install the plugin
openclaw plugins install @lansenger-pm/openclaw-lansenger-channel

# 2. Copy to extensions directory (required due to OpenClaw CLI discovery bug)
mkdir -p ~/.openclaw/extensions/lansenger
cp -r ~/.openclaw/npm/node_modules/@lansenger-pm/openclaw-lansenger-channel/* \
     ~/.openclaw/extensions/lansenger/

# 3. Restart gateway
openclaw gateway restart
```

> ⚠️ Step 2 is required because `openclaw channels add` only discovers plugins in the `extensions/` directory, not from npm-installed packages. This is an [OpenClaw upstream bug](https://docs.openclaw.ai), not a plugin issue.

### Via npm

```bash
# First install the npm package manually, then configure via CLI
npm install -g @lansenger-pm/openclaw-lansenger-channel
openclaw channels add --channel Lansenger --app-token "your-appid" --secret "your-appsecret"
```

### Installation de développement (lien local)

```bash
cd /path/to/openclaw-lansenger-channel
npm install
openclaw plugins install --link
openclaw gateway restart
```

## Configuration rapide

Après l'installation, configurez les identifiants :

> **Compte unique** : `channels add` crée un seul compte. Pour plusieurs bots, voir [Configuration multi-bot](#configuration-multi-bot) ci-dessous.

```bash
# Standard (utilise la passerelle par défaut https://open.e.lanxin.cn/open/apigw)
openclaw channels add --channel Lansenger \
  --app-token "your-appid" \
  --secret "your-appsecret"

# Déploiement entreprise (URL de passerelle personnalisée)
openclaw channels add --channel Lansenger \
  --app-token "your-appid" \
  --secret "your-appsecret" \
  --base-url "https://apigw.lx.qianxin.com"
```

Puis redémarrez :
```bash
openclaw gateway restart
```

Obtenir les identifiants : **Lansenger Desktop** → **Contacts** → **Bots** → **Personal Bots** → cliquer sur l'icône **ℹ️** (le client mobile ne permet pas de voir les identifiants).

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
      "homeChannel": "lansenger",
      "enabled": true,
      "allowFrom": ["your-appid"],
      "dmSecurity": "paired",
      "accounts": {
        "your-appid": {
          "appId": "your-appid",
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
| `dmSecurity` | Politique DM : `paired`, `allowlist`, `open` | `paired` |
| `accounts` | Configuration multi-bot | — |

### Configuration multi-bot

> ⚠️ `openclaw channels add` ne supporte qu'un seul compte et **remplace** le précédent à chaque exécution. Pour ajouter plusieurs bots, utilisez `openclaw config set` avec la structure `accounts`.

Après avoir ajouté le premier compte via `channels add`, ajoutez des bots supplémentaires avec `openclaw config set` :

```bash
# Ajouter un deuxième bot (remplacez appid/appsecret/gateway par vos valeurs)
openclaw config set channels.lansenger.accounts.your-appid-2.appId "your-appid-2"
openclaw config set channels.lansenger.accounts.your-appid-2.appSecret "your-appsecret"
openclaw config set channels.lansenger.accounts.your-appid-2.apiGatewayUrl "https://apigw.lx.qianxin.com"

# Lier chaque bot à un agent différent
openclaw config set channels.lansenger.accounts.your-appid-2.agentId "main"
openclaw config set channels.lansenger.accounts.your-appid-1.agentId "test"

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
      "dmSecurity": "paired",
      "accounts": {
        "your-appid-2": {
          "appId": "your-appid-2",
          "appSecret": "...",
          "agentId": "main",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        },
        "your-appid-1": {
          "appId": "your-appid-1",
          "appSecret": "...",
          "agentId": "test",
          "apiGatewayUrl": "https://apigw.lx.qianxin.com"
        }
      }
    }
  }
}

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

### Lier un bot à un agent (configuration)

La liaison bot-agent utilise `agentId` dans la configuration du compte ou OpenClaw `bindings[]` :

```bash
# agentId par compte (recommandé)
openclaw config set channels.lansenger.accounts.your-appid.agentId "main"

# Ou via OpenClaw bindings[]
openclaw config set bindings '[{"agentId":"main","match":{"channel":"lansenger","peer":{"kind":"direct","id":"your-userid"}}}]'
```

> Voir [Configuration multi-bot](#configuration-multi-bot) pour le routage multi-agent.

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

Configurez `agentId` dans la configuration du compte, ou utilisez OpenClaw `bindings[]` pour le routage multi-agent.

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

- **v2.7.2** — Ajout fichier VERSION ; complétion changelog dans 5 READMEs ; régénération package-lock.json
- **v2.7.0** — Enregistrement des outils comme objets simples (pas fonctions factory) ; utilisation de l'état runtime pour client/target — correction de l'enregistrement des outils de plugin externe
- **v2.6.0** — Enregistrement inconditionnel des outils (résolution du compte à l'exécution) ; suppression du ghost delete_message
- **v2.5.2** — Correction guide SKILL/README mention (formatText supporte reminder) ; AppArticles utilise `summary` pas `description` ; suppression delete_message
- **v2.5.1** — Retour sysMsg (non affiché) et deleteMessage (API 10000) ; revoke chatType bot/group uniquement
- **v2.5.0** — Ajout sysMsg pour revoke, outil deleteMessage (retiré en 2.5.1)
- **v2.4.0** — Correction assemblage message : wrap() exclut msgType de msgData ; appArticles msgType/summary/tableau plat ; linkCard champs requis
- **v2.3.0** — Suppression sendGroupText/sendGroupFormatText ; routage via msgTarget
- **v2.2.8** — Correction livraison MEDIA (delivery.deliver traite payload.mediaUrls) ; correction reconnect WS
- **v2.2.5** — Correction uploadMedia endpoint, stop key, validation statut, sendCard params dynamiques
- **v2.2.0** — Ajout 9 outils agent avec contracts.tools + toolMetadata
- **v2.0.0** — Migration kernel canal, version initiale

## Licence

MIT — voir [LICENSE](LICENSE).

## Contribuer

1. Fork le dépôt
2. Créer une branche de fonctionnalité
3. Effectuer vos modifications
4. Exécuter les tests : `npx vitest run`
5. Soumettre une pull request