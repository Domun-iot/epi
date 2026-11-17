# Ports et adapters de stockage

Le choix d’un stockage se fait dans tauri/src/storage/adapters.js, via createStorageAdapter. L’interface utilise un port de session stable, sans décider elle-même où écrire chaque objet. Le moteur métier conserve son port de persistance load()/save(state, previous).

## Stockages séparés

| Adapter | Déploiements | Persistance et comportement |
| --- | --- | --- |
| native-files | APK/iOS et applications Windows, Linux, macOS | Commandes Tauri vers les fichiers Rust. Répertoire privé mobile, dossier applicatif ou portable sur PC. Chemins, verrous, jeux par compte et fonctionnement hors connexion conservés. |
| personal-api | Web personnel, dev-web et release Node personnelle | Actions HTTP vers l’installation Node locale, qui conserve ses fichiers et son jeu actif commun avec Tauri/CLI. Aucun choix automatique de localStorage sur ce déploiement. |
| hosted-api | Web partagé, compte PRO confirmé et navigateur sans usage local | Actions HTTP vers le jeu du compte sur le serveur. Authentification et abonnement PRO contrôlés côté serveur avant lecture ou écriture. Pas de file de synchronisation cliente. |
| preview | Aperçu de développement du client Tauri dans un navigateur | Simulation historique dans localStorage, sans synchronisation. Comportement conservé, isolé du nouveau mode utilisateur. |
| browser-local | Web partagé anonyme, FREE ou déjà utilisé localement | localStorage de cette origine et de ce navigateur. Jeux séparés par compte, journal durable et synchronisation exclusivement PRO. |

Les trois premiers modes et la simulation existaient avant cette extraction. browser-local est le nouveau mode utilisateur. Le CLI garde ses modules de fichiers Node et le même protocole JSON ; il ne passe pas par la façade de session de l’interface graphique. Le serveur utilise toujours web/file-storage.js pour la persistance et SQLite pour les comptes et échanges de synchronisation.

## Contrats

- **SessionPort** : open(options) retourne les actions du moteur métier avec les mêmes retours et notifications, ainsi que les imports/exports de fichiers lorsque disponibles. Les adapters HTTP exécutent ces actions côté serveur ; les adapters locaux injectent leur persistance dans le moteur du client.
- **DatasetPort** : context, prepare, activate, logout, et confirmSync pour les stockages synchronisables. Il sépare la sélection d’un compte de sa persistance et de son jeton. Le web partagé ajoute select(info) après confirmation des droits.
- **PersistencePort** : load, save, exportFiles, importFiles, pendingTransactions, archiveTransactions, integrateTransactions pour les données locales complètes. Le moteur n’exige que load/save, avec l’intégration de transactions en capacité supplémentaire. Les API ne simulent pas une sauvegarde d’instantané : leurs garanties de concurrence restent côté serveur.

Les propriétés kind, remote et synchronizes expriment les capacités de l’adapter. La connexion au compte, les dialogues de fusion, les protections de génération et le transfert PRO des transactions restent distincts. Un autre support fournit les mêmes contrats et s’inscrit dans la composition, sans disperser des branches de stockage dans l’interface.

## Sélection du web partagé

| Situation | Résultat |
| --- | --- |
| Visite anonyme sans enregistrement | Adapter navigateur, sans flag par la seule visite. |
| Premier enregistrement anonyme | Adapter navigateur ; mémorisation durable de l’usage local. |
| Compte confirmé FREE, même sans données | Adapter navigateur ; mémorisation immédiate de l’usage local. Aucun accès aux données serveur ni transfert entre navigateurs. |
| Compte confirmé PRO sans usage local | Adapter API hébergée. Les autres navigateurs PRO en mode API accèdent au même jeu serveur. |
| Compte PRO avec usage local mémorisé | Adapter navigateur conservé ; première réconciliation puis synchronisation PRO existante. |
| Passage FREE vers PRO | Reste local ; réconciliation des données distantes comme pour les applications installées. |
| Passage API PRO vers FREE dans un écran ouvert | Le dernier état chargé de ce compte devient un jeu navigateur et l’usage local est mémorisé. Les fichiers serveur restent conservés et deviennent inaccessibles en FREE. |
| Vérification d’abonnement indisponible | Ne confirme pas FREE et ne crée pas de flag par erreur. Le serveur fournit entitlementVerified: false pour ses droits de secours ; une panne de l’API ne déclenche pas de bascule implicite. |

La sélection automatique concerne uniquement le build hosted. Les builds natifs et le web personnel conservent leur fonctionnement.

Le document epi-browser-storage-v1 contient le flag usageLocal, la sélection et sa génération, les données par compte, les journaux, les suppressions et les copies de récupération. La présence de données empêche aussi une bascule automatique si un flag a été retiré manuellement. Un nouveau compte ne récupère jamais les données locales d’un autre compte. Après rattachement, la déconnexion désélectionne le compte et verrouille ses données sans les effacer.

## Durabilité et limites

Une mutation navigateur écrit données et journal dans un seul localStorage.setItem. Un dépassement de quota ou une indisponibilité fait échouer l’action sans annoncer de succès ni remplacer le document précédent. Les écritures vérifient le jeu, sa génération et l’état chargé ; une modification concurrente déclenche le rechargement plutôt qu’un écrasement. Les Web Locks sérialisent les mutations entre onglets quand disponibles ; les autres navigateurs conservent le contrôle optimiste, sans garantie de sérialisation entre processus.

Le journal utilise les mêmes chemins, UUID, versions et noms de transactions que les fichiers Node/Rust. Les suppressions empêchent la réapparition d’une ancienne écriture. Les ZIP incluent préférences, notifications, pesées en attente, vues et historique ; les entrées entrantes validées sont rejouées et remises en attente. Le premier transfert garde la révision distante revue. Une réparation du même compte conserve les écritures locales plus récentes et les suppressions.

Les données locales sont soumises au quota et à l’effacement du navigateur, à son profil et à l’origine web ; ce mode n’est pas une sauvegarde externe ni un chiffrement. Journaux et copies de récupération consomment aussi du quota. FREE ne partage rien entre navigateurs. PRO conserve les droits et la synchronisation des autres clients locaux. L’API commune évite une file cliente ; un écran déjà affiché doit encore être rechargé pour refléter une modification distante.

Les tests couvrent sélection, redémarrage, séparation des comptes, quotas, concurrence, échanges avec le stockage Node et parcours du client hébergé compilé dans Chrome. Les exécutables et appareils physiques gardent leur validation propre ; cette refactorisation ne modifie pas le code Rust.
