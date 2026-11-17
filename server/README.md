# Serveur de synchronisation éPI

API HTTP autonome, développée en TypeScript. Node.js 22.13 ou supérieur suffit pour exécuter le serveur compilé. Le serveur utilise SQLite via `node:sqlite` et crée son schéma au démarrage dans `server/data/epi.sqlite`.

## Lancer le serveur

Depuis la racine du dépôt, utilisez les scripts suivants (extension `.bat` sous Windows).

| Script | Action |
| --- | --- |
| `run/prep/server.sh` | Installe les dépendances de compilation verrouillées. |
| `run/build/server.sh` | Vérifie et compile le TypeScript dans `server/dist/`. |
| `run/dev/server.sh` | Lance le TypeScript et redémarre à chaque changement de source. |
| `run/server.sh` | Lance le serveur compilé et le construit au premier démarrage si nécessaire. |

Modifiez `server/config.js` pour changer le port (8787 par défaut), l'adresse d'écoute ou le fichier SQLite. Le serveur écoute par défaut sur `127.0.0.1`. Redémarrez le serveur après une modification de la configuration. HTTP transmet les mots de passe, les jetons et les données en clair. Pour un accès distant, terminez HTTPS devant le serveur.

Vérification locale avec `npm --prefix server test`.

## API

Les corps POST sont envoyés en JSON avec `Content-Type: application/json`. Les routes de synchronisation utilisent `Authorization: Bearer <token>`.

| Méthode et route | Corps | Réponse |
| --- | --- | --- |
| `POST /v1/accounts` | `{"email":"a@example.org","password":"mot-de-passe"}` | `201` et `{"email":"a@example.org"}`. `409 account_exists` si l'adresse existe déjà. |
| `POST /v1/device-tokens` | `{"email":"a@example.org","password":"mot-de-passe","deviceId":"pc-1"}` | `200` avec notamment `{"token":"…","paid":false,"paidUntil":null}`. |
| `GET /v1/account` | Jeton d’appareil. | Compte courant, UUID stable `accountId`, droits `paid`/`paidUntil`, langue et configuration Google. |
| `GET /v1/dataset` | Jeton PRO. | `{accountId,files,summary,revision}` : état matérialisé et historique, avec `summary={count,from,to,hasData}`. |
| `GET /v1/dataset/summary` | Jeton PRO. | Même résumé et révision, sans les fichiers. |
| `POST /api/session` | Jeton d’appareil et `{action,args,datasetId}`. | Session hébergée du compte authentifié ; `401` sans session valide, `409 dataset_changed` si le compte demandé diffère. |
| `DELETE /v1/device-tokens` | En-tête `Authorization: Bearer <token>` | `204`. Révoque ce jeton sans supprimer les accusés de l’appareil. |
| `POST /v1/transactions` | Objet JSON `{"transactions":[…]}` ou une transaction JSON par ligne (`application/x-ndjson`). | `200` et `{"inserted":1,"uuids":["…"]}` avec les UUID confirmés. |
| `GET /v1/transactions/pending` | Paramètre facultatif `after` | `200` et `{"transactions":[…],"next":null}`. Les transactions horodatées sont triées par nom de fichier UTC. Si `next` est renseigné, le client le transmet dans `after` pour lire la page suivante. |
| `POST /v1/transactions/acknowledge` | `{"uuids":["…"]}` | `200` et `{"inserted":1}` pour un nouvel accusé. |

Les erreurs ont la forme `{"error":"code"}`. L'inscription est ouverte. L'identifiant d'appareil est choisi par le client et doit rester stable pour cette instance. Il accepte 1 à 128 caractères parmi les lettres ASCII, chiffres, points, tirets et underscores. Chaque émission remplace le jeton précédent de l'appareil. Après plus de 30 jours sans utilisation, le jeton est effacé et l'API renvoie `401 token_expired` jusqu'à une nouvelle connexion par mot de passe ou avec Google. Les accusés de l'appareil sont conservés.

Le format d’envoi JSON accepte jusqu’à 100 entrées et 4 Mio par requête. Le format NDJSON permet d’envoyer la file locale en une requête, avec la même limite de taille par transaction. Le serveur valide et enregistre le flux par groupes d’au plus 100 transactions et 4 Mio. Si l’envoi est interrompu, le client peut renvoyer le lot entier. Le serveur conserve le premier contenu déposé pour un UUID. Un renvoi équivalent confirme cet UUID et peut ajouter le nom horodaté lorsqu’il manque à l’entrée d’origine. Un UUID associé à un JSON différent reste absent de la liste des confirmations. Les UUID utilisent le format canonique en minuscules. Un accusé de téléchargement sur un UUID inconnu du compte est ignoré et peut être renvoyé après le dépôt.

## Gestion des abonnements par domun

L’API privée accepte le jeton de service défini par `EPI_DOMUN_API_TOKEN` sous forme de 64 caractères hexadécimaux minuscules. domun l’envoie via `Authorization: Bearer <token>`. Réservez `/v1/domun/` à la boucle locale en production. En l’absence de jeton, ces routes répondent `404`.

| Méthode et route | Corps | Réponse |
| --- | --- | --- |
| `GET /v1/domun/accounts` | Aucun. Paramètre `after` facultatif. | `200` avec `{"accounts":[{"id":"…","email":"a@example.org","paidUntil":null}],"next":null}`. Transmettez `next` dans `after` pour lire la page suivante. |
| `DELETE /v1/domun/account-deletion` | En-tête `X-Domun-Device` avec le jeton d’appareil du compte. | `204`. Marque le compte et bloque ses accès. |
| `GET /v1/domun/accounts/purge` | Paramètre `after` facultatif. | `200` avec `accounts`, où chaque compte contient `id`, `email` et `deletedAt`, et le curseur `next`. |
| `POST /v1/domun/accounts/purge` | `{"ids":["…"]}` | `200` avec le nombre de comptes purgés dans `purged`. Seuls les comptes listés et marqués depuis strictement plus d’un mois calendaire UTC sont éligibles. |
| `PUT /v1/domun/accounts/<id>/entitlement` | `{"paidUntil":"2027-01-01T00:00:00.000Z"}` ou `{"paidUntil":null}` en JSON. | `204`. `404 account_not_found` si le compte a été supprimé. |

Le serveur vérifie auprès de `EPI_DOMUN_BILLING_URL` (boucle locale, jeton `EPI_DOMUN_API_TOKEN`) les droits de chaque envoi, lecture et acquittement de transactions. Un compte FREE reçoit `403 pro_required`; une panne de l’admin donne `503 subscription_unavailable`. La connexion au compte et les données déjà stockées restent disponibles pour le prochain abonnement.

L’identifiant du compte, `domunId` dans `GET /v1/account`, reste stable. `accountId` exprime les mêmes 128 bits au format UUID canonique ; il est fourni par le serveur aux clients et sert à sélectionner leur dossier de données. Une réinscription reçoit un nouvel identifiant. Les réponses de connexion par mot de passe ou avec Google et `GET /v1/account` renvoient `paid` et `paidUntil`. `paidUntil` contient l’échéance UTC, même si elle est passée, ou `null` pour un compte sans échéance. `paid` vaut `true` tant que l’échéance est dans le futur.

## Comptes dans l’application

Ouvrez « Compte » dans l’application web ou Tauri. La création du compte ouvre une session. La déconnexion explicite ferme l’accès local au jeu du compte même hors connexion ; la révocation distante du jeton est tentée quand le serveur est joignable. L’expiration d’un jeton conserve le dernier jeu actif sur une installation locale ; le web hébergé exige une nouvelle connexion.

Les clients web et Tauri accèdent aux comptes via `https://epi.domun.eu` dans tous les modes, y compris en développement. Le proxy doit transmettre les méthodes `GET`, `POST`, `DELETE` et `OPTIONS` des routes de compte, ainsi que les en-têtes CORS.

### Connexion Google

1. Créez un client OAuth de type **Application Web** dans Google Cloud, configurez l’écran de consentement et ajoutez l’URI de redirection exacte, `https://epi.domun.eu/v1/google/callback` en production. En mode test, ajoutez les comptes Google autorisés.
2. Avant de démarrer le serveur, définissez `EPI_GOOGLE_CLIENT_ID`, `EPI_GOOGLE_CLIENT_SECRET` et `EPI_GOOGLE_REDIRECT_URI`. Pour un essai sur le même ordinateur, vous pouvez enregistrer et utiliser `http://127.0.0.1:8787/v1/google/callback`. Le navigateur doit pouvoir joindre l’URI de retour. Le serveur doit pouvoir joindre les services Google en HTTPS.
3. Relancez le serveur. Dans « Compte », l’action Google permet de se connecter, de créer un compte ou de gérer l’association. Pour se connecter, créer un compte ou associer Google, Tauri ouvre le navigateur système, y compris sur Android. Sur le web, le choix du compte s’affiche dans un nouvel onglet. Après validation, revenez dans éPI.

Le serveur échange le code d’autorisation avec Google via PKCE, valide le jeton OpenID Connect reçu directement du serveur Google en HTTPS et conserve l’identifiant stable `sub`. Les jetons Google servent uniquement à cet échange. éPI délivre ensuite son jeton d’appareil habituel. Une adresse existante exige une connexion éPI et la confirmation du mot de passe pour associer Google.

Pour délier Google, confirmez votre mot de passe éPI dans l’application. Si Google est votre seul moyen de connexion, choisissez et confirmez un nouveau mot de passe éPI dans le même écran. Le déliage utilise la session éPI et conserve les autorisations enregistrées chez Google.

Les demandes Google expirent après cinq minutes et sont conservées en mémoire. Si vous utilisez plusieurs instances d’API, le début de la demande, le callback et sa finalisation doivent atteindre la même instance. Évitez de journaliser la chaîne de requête du callback, qui contient le code d’autorisation et le paramètre d’état. Sans configuration Google, les connexions par mot de passe restent disponibles.

## Application web hébergée

Le serveur importe `web/hosted-api.js` au démarrage, depuis le dépôt complet. Les données de chaque compte sont matérialisées dans `server/data/accounts/<accountId>` ; l’UUID utilisé vient du jeton vérifié par le serveur, jamais du chemin ou du corps fournis par le navigateur. Les actions de synchronisation brutes ne sont pas exposées dans `/api/session`. Les actions PRO sont contrôlées côté serveur. Un compte FREE utilise ses propres données hébergées, sans accès aux routes de synchronisation. Ses modifications restent dans son journal et pourront être synchronisées après passage en PRO.

Le journal SQLite est rejoué indépendamment des accusés des appareils pour reconstruire les données existantes. Une ancienne opération métier dépourvue de nom horodaté bloque la reconstruction avec `503 dataset_recovery_required` ; elle nécessite une migration explicite plutôt qu’une date de suppression inventée. Les anciennes enveloppes opaques sans opération métier sont ignorées par cette matérialisation. Les modifications web PRO sont ajoutées au même journal, sans créer un accusé de téléchargement pour le compte d’un appareil tiers. Les suppressions restent mémorisées dans l’historique : une ancienne transaction ne recrée pas une fiche supprimée. La purge finale d’un compte supprime également son dossier hébergé.

Pour le premier rattachement local PRO, le client lit un instantané cohérent, montre les comptes de pesées et plages de dates, puis utilise éventuellement `If-Match: <revision>` au premier envoi. Une révision devenue obsolète donne `409 dataset_changed` avant écriture du lot. L’instantané inclut les historiques et l’index pour éviter de rejouer les opérations déjà appliquées. Les corps d’activation locale sont limités à 32 Mio ; un instantané dépassant cette limite doit être traité par une migration adaptée avant rattachement.

Le build `node web/build.mjs --hosted` produit les fichiers du client hébergé. Voir le [guide de build](../docs/BUILD.md) pour les cibles et les prérequis.

## Boucle côté client

Le client télécharge les transactions au démarrage et lors d’un changement de session de compte. Il suit le curseur `next` et accuse les UUID intégrés ou déjà présents localement. Il envoie ensuite la file locale, avec relance en arrière-plan. Un dépôt accepté crée aussi le reçu de l’appareil expéditeur, qui évite de lui renvoyer sa propre transaction. Le [fonctionnement de la synchronisation et ses cas limites](../docs/SYNCHRONISATION.md) détaille le rejeu, les garanties de stockage et les conflits.
