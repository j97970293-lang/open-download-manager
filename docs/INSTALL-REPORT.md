# Rapport d'installation et de construction

Date : 2026-11-05 (Antananarivo) · Machine : Debian 13, x86_64, Node 20.20.2 (+ Node 24.22.2 pour REA)

## 1. Dépôts installés

| Dépôt | Ce que c'est | Statut | Emplacement |
| --- | --- | --- | --- |
| [`morluto/rea`](https://github.com/morluto/rea) | REA — MCP de rétro-ingénierie (binaire + sidecar natif) | **installé** : `rea-agents@6.8.0`, binaire `~/.local/bin/rea` | `~/rea` (source) · `~/.local/bin` (exécutable) |
| [`getartcraft.com/apps/craft-anything`](https://getartcraft.com/apps/craft-anything) | Craft Anything — moteur d'étude de logiciels (Rust) | **installé** : v0.2.0 (archive officielle linux-x86_64, 66,357,097 o) | `~/installed/craft-anything-0.2.0-linux-x86_64/` |
| [`maxbogo/awesome-ai-tools-for-ui`](https://github.com/maxbogo/awesome-ai-tools-for-ui) | Collection d'outils de design UI (utilisée comme référence de design) | **cloné** | `~/awesome-ai-tools-for-ui` |
| [`storytold/craft-anything`](https://github.com/storytold/craft-anything) | Source du moteur Craft Anything | **cloné** | `~/craft-anything` |

### Vérifications effectuées

```console
$ rea --version
6.8.0
$ craft-anything-cli doctor
{"healthy": true, ... "MCP server answered (protocol 2025-06-18, 29 tools listed)"}
$ craft-anything-cli capabilities
{"tools": 314, "toolsets": [...], "analysis_mode": "clean-room"}
$ craft-anything-cli --deep triage 1dmplus.apk
kind: apk · sha256: 6d334697...37b47 · 55 711 317 octets
$ rea doctor
node 24.22.2 ok · host debian 13 ok · hopper absent (optionnel, `rea setup`)
```

Notes d'installation :
- REA exige Node ≥ 22.23.4 ; Node 24.22.2 a été installé localement dans `~/.local/node24` pour l'installer (`npm i -g --prefix ~/.local rea-agents@6.8.0`).
- L'installeur REA ne pose pas ses moteurs optionnels (Hopper, Ghidra, Frida…) : `rea setup` les ajoute si besoin.
- Craft Anything a été installé depuis son **archive de release officielle**, pas compilé : Rust n'est pas présent sur la machine.

## 2. Mission : réimplémentation open source

Référence analysée : `idm.internet.download.manager.plus` **18.2** (1DM+), APK de **55 711 317 octets**,
SHA-256 `6d334697c976990e2ad208774a5768c5914a92d37bd7354f497c79ea14b37b47`.

> Le lien signé R2/Cloudflare fourni initialement était **expiré** (HTTP 400) ; l'APK a donc été obtenu
> via le second lien fourni (1DM+ v18.2), téléchargé intégralement puis analysé.

**Méthode** : clean-room. Analyse **statique du manifeste** uniquement (package, permissions, composants,
intent-filters) → liste de capacités → réimplémentation à partir des **spécifications publiques**
(RFC 9110, RFC 6266/5987, RFC 8216 HLS, ISO/IEC 23009-1 DASH, spec MCP). Aucun décompilage, aucune
ressource extraite, aucun asset copié, aucune interception réseau.

**Livrable** : `open-download-manager/` — ~3 950 lignes, **0 dépendance à l'exécution** (Node 20+).

| Couche | Contenu |
| --- | --- |
| `packages/core` | moteur : transferts segmentés, reprise après crash, sondage des ranges, shaping (seau à jetons), file priorisée, reprise/backoff, checksums, sniffing MIME, HLS/DASH, fenêtres horaires |
| `apps/cli` | `odm add/list/watch/pause/resume/rm/grab/manifest/probe/serve/mcp` |
| `apps/server` | API REST + flux SSE + dashboard + serveur MCP (7 outils, 2 ressources, 1 prompt) |
| `apps/web/public` | dashboard sans build (vanilla ES modules), thème sombre/clair, mobile |
| `docs/` | `PARITY.md` (preuves), `DESIGN.md` (système de design), `LEGAL.md` (frontière juridique) |

### Vérification

```
npm test        → 15 tests, 15 passés, 0 échec
npm run smoke   → CLI + probe/grab/manifest + REST + SSE + MCP : PASSED
captures        → docs/screenshots/{dashboard-dark,dashboard-light,dashboard-mobile}.png
```

### Design

Le dashboard suit les principes de [`awesome-ai-tools-for-ui`](https://github.com/maxbogo/awesome-ai-tools-for-ui) :
un seul accent, échelle typographique réelle, espacement sur grille de 4 px, animations ≤ 180 ms respectant
`prefers-reduced-motion`, et un élément-signature — **la barre de progression segmentée par connexion**
(la parallélisme devient visible, et une pause fige les curseurs sur place).

## 3. Publication

| Destination | Contenu |
| --- | --- |
| GitHub `j97970293-lang/open-download-manager` | le livrable (branche `main`, commit `e3bf22d`) |
| GitHub `j97970293-lang/rea-mirror` | miroir complet de `morluto/rea` (branches + 40 tags) |
| GitHub `j97970293-lang/awesome-ai-tools-for-ui` | miroir de `maxbogo/awesome-ai-tools-for-ui` |
| Google Drive → `Open Download Manager/` | archives, captures, rapport, paquet Craft Anything |

## 4. Limites connues (honnêtes)

- HLS/DASH : variantes listées et téléchargées en flux direct ; pas encore de remux segment→conteneur unique.
- Pas d'extension navigateur ni de client Android (l'API REST est prête pour les deux).
- Les flux DRM/chiffrés sont détectés et refusés par construction.
- `npm start` sert le dashboard local ; l'aperçu hébergé de l'environnement peut demander `ODM_DEMO=1` pour le bouton de démo.
