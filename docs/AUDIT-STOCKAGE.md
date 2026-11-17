# Audit du stockage éPI — 17 novembre 2026

Audit réalisé après l'introduction des jeux par compte et avant la publication du client web. Les corrections sont accompagnées de tests de régression. Aucun compte ni jeu de test n'est créé en production.

## Périmètre des variantes

| Variante | Racine et accès | Vérification |
| --- | --- | --- |
| Windows installé ou portable, Tauri | EPI_DATA_DIR absolu, découverte de data en remontant depuis le programme, sinon dossier applicatif ; invoke vers Rust | Tests Rust Windows et scénarios Chrome simulant les commandes natives |
| Linux, paquet ou AppImage | Même sélection ; APPIMAGE permet de partir du fichier original plutôt que du montage temporaire | Lecture des branches spécifiques, logique de découverte et lanceurs shell testés ; pas d'exécution d'un paquet Linux sur une distribution cible |
| macOS Tauri | Dossier applicatif macOS ou racine portable/explicite | Lecture des chemins et de la logique partagée ; pas de machine macOS utilisée |
| Android et iOS | Répertoire privé de l'application ; aucune racine PC partagée | Compilation Rust Android aarch64 hors ligne réussie ; branche iOS relue, sans compilation ni essai matériel iOS |
| CLI de développement et exécutable autonome | Racine commune aux versions PC ; dossier du binaire pour SEA | Tests CLI et lanceurs, chemins avec espaces, sélection/génération du jeu actif |
| Web personnel, développement Vite et release Node | Installation locale ; endpoint de fichiers /api/session ; usage anonyme initial permis | Tests API locale, release réellement construite et démarrée avec données temporaires |
| Web hébergé | Racine serveur accounts/<UUID> ; compte vérifié côté API à chaque accès | Tests HTTP, Chrome et release hébergée réelle avec deux comptes fictifs isolés |
| Aperçu de l'interface dans un navigateur | Stockage de simulation par navigateur ; aucun transfert de transactions | Tests d'interface ; la réparation distante et la synchronisation restent désactivées |

Le web personnel et le web hébergé restent deux modes de build issus du même code. Le serveur hébergé n'expose jamais le gestionnaire d'installation du web personnel.

## Scénarios couverts

- Racine ancienne, nouvelle, uniquement composée de comptes, absente, verrouillée ou explicitement configurée ; priorité du chemin explicite et refus d'un chemin relatif ambigu entre lanceurs.
- Premier démarrage sans compte ; données anonymes ; rattachement FREE sans consultation du cloud ; rattachement PRO avec compte distant vide ou rempli ; comparaison des nombres et périodes ; fusion, remplacement et annulation.
- Passage FREE vers PRO, retour en FREE, échéance PRO pendant une requête, expiration du jeton, panne réseau et reconnexion ; accès hors ligne au dernier jeu local et déconnexion volontaire durable.
- A vers B puis A, plusieurs onglets, enregistrement/import/export en vol, réponses retardées, connexion Google annulée, échec de persistance des identifiants, fermeture et redémarrage.
- Import ZIP et historique, doublons, champs invalides, chemins dangereux et liens symboliques ; versions concurrentes, suppression suivie d'une ancienne écriture, restauration volontaire.
- Migration ou rattachement interrompu, reprise d'une bascule, verrou d'un autre processus, propriétaire mort, réclamation simultanée d'un verrou, sauvegarde et restauration.
- Écriture web durable avec publication SQLite temporairement impossible ; reprise par le téléchargement d'un autre client après redémarrage ; instantané complet indépendant des accusés déjà présents.
- Déploiement interrompu avant ou après les déplacements des builds ; restauration des scripts, marqueurs et anciens artefacts ; conservation des données actives.

## Défauts trouvés et corrigés

| Priorité | Défaut | Correction |
| --- | --- | --- |
| P1 | La première révision distante validée était perdue au redémarrage avant émission. | Révision conservée dans la configuration d'installation ; seul l'accusé du même compte et de la même génération peut la retirer. |
| P1 | Des droits PRO pouvaient expirer après l'autorisation initiale d'une requête lente ou en attente. | Vérifications au traitement, avant mutation et après export. |
| P1 | Une annulation Google ou une réponse d'un ancien compte pouvait terminer une connexion tardive. | Époques d'interaction, annulation des requêtes, contrôle après chaque attente, nettoyage du compte en échec. |
| P1 | Un jeton non effaçable pouvait rouvrir un jeu après déconnexion explicite. | Authentification mémoire supprimée même si le stockage échoue ; l'installation verrouillée ne reprend pas automatiquement ce jeton. |
| P1 | Un arrêt entre publication d'un nouveau dossier de compte et sélection pouvait laisser un rattachement incomplet. | Journal de reprise également sur le premier rattachement, sauvegardes et contrôles des conteneurs. |
| P1 | Certaines lectures CLI effectuaient une migration d'identité sans le verrou d'installation. | Lectures/migrations/écritures regroupées sous le même verrou. |
| P1 | Deux récupérateurs pouvaient supprimer la réclamation récente d'un verrou abandonné. | Tickets de récupération immuables et choix non bloquant ; réentrance Node limitée au même contexte asynchrone. |
| P1 | Une interruption entre un déplacement de build et la mise à jour d'un indicateur pouvait casser le rollback. | Restauration fondée sur les sauvegardes présentes et intention de remplacement enregistrée avant déplacement. |
| P2 | Une publication SQLite échouée faisait annoncer un échec après une écriture web réussie. | Retour de l'état sauvegardé avec synchronisation en attente ; reprise du journal par la prochaine consultation web ou réception native. |
| P2 | Les archives pouvaient porter des opérations invalides malgré un UUID correct. | Validation des opérations, valeurs, chemins et doublons avant toute écriture de l'historique. |
| P2 | Les anciens fichiers interface/session et les JSON avec BOM n'étaient pas tous repris dans le journal initial. | Baseline complète et normalisation cohérente ; préférences de fenêtre exclues des échanges. |
| P2 | Un compte contenant seulement des pesées en attente était présenté comme vide. | Détection de ces données sans les compter comme des pesées enregistrées. |
| P2 | Une restauration d'ancien cache pouvait conserver des accusés masquant des données serveur plus récentes. | Réparation explicite par l'instantané complet du même compte, fusionnant les versions et conservant les suppressions. |
| P2 | Un échec tardif d'installation pouvait laisser les nouveaux marqueurs de déploiement. | Restauration des marqueurs avec les scripts et tests d'échec injecté. |

Les bandeaux, détails, formulaires et journaux BLE d'un compte sont également supprimés de l'interface au passage à un autre. Les journaux BLE persistés restent rattachés à leur jeu. Une réparation du même compte conserve la vue et les dialogues utiles.

## Résultats des vérifications

| Suite | Résultat |
| --- | --- |
| Rust Windows | 29/29 |
| Vérification de compilation Android aarch64 | Réussie hors ligne avec le NDK installé |
| CLI | 19/19 |
| Gestion des comptes/fichiers Node | 17/17, y compris une jonction Windows réellement créée hors bac à sable |
| Verrou interprocessus Node | 7/7, dont réclamations simultanées et contextes asynchrones indépendants |
| Journal Node | 8/8 |
| API serveur et sessions hébergées | 20/20 |
| Installation et retour arrière | 4/4 |
| Contrôleur de sélection et réparation | 10/10 |
| Interface Chrome | 91/91 |
| Lanceurs Windows et Git Bash | 16 variantes simulées et 2 parcours fixture |
| Releases web réellement construites | Hébergée et personnelle démarrées avec stockage temporaire isolé |

La dernière correction de séquencement de déconnexion invalide une transition en cours, attend sa fin, puis verrouille les données ; une arrivée d'un autre compte pendant cette attente ne peut pas être déconnectée par l'ancienne demande.

## Limites de la validation

La compilation Android valide le chemin mobile et Unix du stockage ; elle ne produit pas un essai utilisateur sur téléphone. Le test de jonction Windows a été exécuté avec les permissions du poste et a réussi.

Les tests automatisés ne remplacent pas les essais avec une balance réelle, un APK installé, un paquet Linux, macOS ou iOS. L'exécution Chrome locale vérifie le client compilé et les flux HTTP, pas les particularités d'une WebView mobile physique. Les fichiers locaux ne sont pas chiffrés : le verrouillage applicatif ne protège pas contre un utilisateur du système ayant accès au disque.

Le protocole conserve une comparaison temporelle des versions ; des horloges très décalées restent une limite. Les sauvegardes et journaux doivent faire l'objet d'une politique de rétention. Une restauration opérateur du serveur doit considérer à la fois SQLite et les fichiers de comptes ; le déploiement n'écrase jamais automatiquement les données actives avec une sauvegarde ancienne.
