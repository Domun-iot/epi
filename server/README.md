# Serveur de synchronisation éPI

API HTTP autonome, développée en TypeScript. Node.js 22.13 ou supérieur suffit pour exécuter le serveur compilé. Le serveur utilise SQLite via `node:sqlite` et crée son schéma au démarrage dans `server/data/epi.sqlite`.

## Lancer le serveur

Depuis la racine du dépôt, utilisez les scripts suivants (extension `.bat` sous Windows).

| Script | Action |
| --- | --- |
| `run/prep-server.sh` | Installe les dépendances de compilation verrouillées. |
| `run/build-server.sh` | Vérifie et compile le TypeScript dans `server/dist/`. |
| `run/rundev-server.sh` | Lance le TypeScript et redémarre à chaque changement de source. |
| `run/run-server.sh` | Lance le serveur compilé et le construit au premier démarrage si nécessaire. |

Modifiez `server/config.js` pour changer le port (8787 par défaut), l'adresse d'écoute ou le fichier SQLite. Le serveur écoute par défaut sur `127.0.0.1`. Redémarrez le serveur après une modification de la configuration. HTTP transmet les mots de passe, les jetons et les données en clair. Pour un accès distant, terminez HTTPS devant le serveur.

Vérification locale avec `npm --prefix server test`.

## API

Les corps POST sont envoyés en JSON avec `Content-Type: application/json`. Les routes de synchronisation utilisent `Authorization: Bearer <token>`.

| Méthode et route | Corps | Réponse |
| --- | --- | --- |
| `POST /v1/accounts` | `{"email":"a@example.org","password":"mot-de-passe"}` | `201` et `{"email":"a@example.org"}`. `409 account_exists` si l'adresse existe déjà. |
| `POST /v1/device-tokens` | `{"email":"a@example.org","password":"mot-de-passe","deviceId":"pc-1"}` | `200` et `{"token":"…"}`. |
| `POST /v1/transactions` | `{"transactions":[{"uuid":"…","type":"create","data":{}}]}` | `200` et `{"inserted":1}` si un UUID est nouveau pour le compte. |
| `GET /v1/transactions/pending` | | `200` et `{"transactions":[…]}`, dans l'ordre d'insertion serveur. |
| `POST /v1/transactions/acknowledge` | `{"uuids":["…"]}` | `200` et `{"inserted":1}` pour un nouvel accusé. |

Les erreurs ont la forme `{"error":"code"}`. L'inscription est ouverte. L'identifiant d'appareil est choisi par le client et doit rester stable pour cette instance. Il accepte 1 à 128 caractères parmi les lettres ASCII, chiffres, points, tirets et underscores. Chaque émission remplace le jeton précédent de l'appareil. Après plus de 30 jours sans utilisation, le jeton est effacé et l'API renvoie `401 token_expired` jusqu'à son renouvellement par email et mot de passe. Les accusés de l'appareil sont conservés.

Les lots acceptent jusqu'à 100 entrées et les requêtes jusqu'à 4 Mio. Un UUID de transaction est au format canonique en minuscules. Le premier JSON déposé pour un UUID est conservé. Un accusé sur un UUID inconnu du compte est ignoré et peut être renvoyé après le dépôt.

## Boucle côté client

1. Déposer les transactions locales avec leurs UUID d'origine, puis accuser réception de celles déjà appliquées localement.
2. Télécharger les transactions en attente, appliquer celles qui manquent à l'historique local et enregistrer durablement leurs UUID.
3. Accuser réception des UUID effectivement appliqués (ou déjà présents dans l'historique local). Répéter à partir de l'étape 2 jusqu'à obtenir un lot vide.

La livraison peut se répéter si le téléchargement ou l'accusé est interrompu. L'historique local empêche de réappliquer un UUID déjà traité. Si deux appareils modifient hors ligne le même objet, la convergence dépend de la règle de résolution des conflits côté client. L'ordre de dépôt du serveur peut différer de l'ordre d'application locale.
