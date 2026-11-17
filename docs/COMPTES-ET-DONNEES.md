# Comptes et jeux de données

Les applications installées et le web personnel fonctionnent sans compte. Le web hébergé exige une connexion vérifiée par le serveur avant toute lecture ou écriture. Les vues PRO et les imports/exports suivent les mêmes droits partout. La synchronisation entre installations est exclusivement PRO.

## Organisation locale

La racine reste déterminée par EPI_DATA_DIR, le dossier data trouvé en remontant depuis le programme, ou le dossier utilisateur. La détection reconnaît l'ancien trio devices/measures/profiles, local, accounts et les marqueurs d'installation. Un dossier de base SQLite du serveur seul n'est pas un dossier de données client.

- local/ contient le jeu anonyme.
- accounts/<UUID>/ contient les fichiers, préférences, notifications et journaux du seul compte concerné.
- installation.json contient le compte actif, le verrouillage permanent du mode compte, la génération du jeu sélectionné, les comptes dont la première synchronisation a été validée et les préférences de fenêtre. Ces informations ne sont ni exportées ni synchronisées.
- backups/ contient les copies de récupération des migrations, rattachements et remplacements.

L'UUID provient de l'identifiant stable du serveur ; une adresse e-mail n'est jamais un nom de dossier. L'ancien contenu de data migre vers local avec sauvegarde et journal de reprise. Utiliser des applications reconstruites avec cette organisation après migration ; une ancienne version ne connaît pas ces sous-dossiers.

## Connexion et fonctionnement hors ligne

Le jeu sélectionné et le jeton en ligne sont indépendants. Au démarrage, le dernier compte actif ouvre son jeu local même sans réseau. Un jeton expiré empêche les échanges mais ne désélectionne pas ces données. Les droits PRO déjà vérifiés restent utilisables localement jusqu'à leur échéance.

Une déconnexion volontaire retire le jeton et la sélection active, sans effacer les fichiers. Dès qu'un compte a été rattaché à l'installation, l'application exige une nouvelle connexion : elle ne recrée jamais un jeu anonyme par défaut, même si les dossiers de comptes ont été retirés. Changer de compte ouvre uniquement son propre dossier.

Le verrouillage de l'interface ne chiffre pas les fichiers. L'utilisateur du système peut lire les sauvegardes et les dossiers s'il en possède les permissions.

## Premier rattachement et passage à PRO

En FREE, le premier rattachement transfère le jeu anonyme dans le dossier du compte, sans consulter ni télécharger les données de synchronisation. Les écritures restent locales ; la file ne part pas vers le serveur.

Au premier rattachement PRO, ou lors du premier passage de FREE à PRO, le client lit un instantané authentifié du compte. Si les deux côtés contiennent des données, il présente le nombre de pesées et les dates extrêmes, puis propose de fusionner, de choisir les données distantes ou d'annuler. Un compte distant vide permet le rattachement automatique. Les données d'un autre compte ne participent jamais à cette opération.

La préparation se fait dans un dossier temporaire. Une fusion part de l'instantané distant, puis intègre les écritures locales et leur état courant selon leurs versions. Les suppressions sont conservées dans le journal afin d'empêcher le retour d'une ancienne écriture. Une restauration volontaire porte une nouvelle date de modification. Une sauvegarde du jeu remplacé reste disponible. Un journal de remplacement permet de terminer une bascule interrompue.

La première émission est conditionnée à la révision distante présentée, conservée dans la configuration même après redémarrage. Si le serveur a changé, les fichiers restent en attente et le choix est proposé à nouveau. Annuler ne publie rien. Les confirmations de réception ne déplacent que les transactions confirmées dans l'archive du même compte.

## Isolation des opérations

Un verrou interprocessus partagé par Node, le CLI et Tauri protège les migrations, bascules et écritures. Un propriétaire actif fait refuser l’opération concurrente ; un verrou abandonné est récupéré après vérification du processus propriétaire. Le service web personnel conserve ce verrou pendant ses opérations de fichiers asynchrones.

Chaque travail asynchrone conserve le compte et la génération du jeu qui l'a lancé. Une réponse ancienne ne met pas à jour le nouveau compte ; les commandes de fichiers refusent une génération devenue périmée, y compris un remplacement du même compte. Les données temporaires de l'interface et les journaux Bluetooth sont séparés lors d'une bascule.

Sur le web hébergé, le serveur vérifie le jeton sur chaque requête et choisit lui-même accounts/<UUID>. Aucun identifiant fourni par le navigateur ne permet de choisir un autre dossier. Les écritures web PRO rejoignent le même journal que les autres clients. Les appels de synchronisation sont refusés en FREE. Les fichiers hébergés sont supprimés lors de la purge définitive du compte.

Un rechargement/synchronisation manuel PRO et la fin d'un import ZIP peuvent réparer le cache depuis l'instantané complet du même compte, indépendamment des anciens accusés. La fusion garde les modifications locales plus récentes et les suppressions. Cette réparation ne redemande pas le choix du premier rattachement et conserve les dialogues du compte courant.

## Vérifications

Les suites de tests couvrent migration et reprise, recherche de data, rattachement FREE, première synchronisation PRO, fusion et remplacement, isolation de deux comptes, expiration, déconnexion hors ligne, génération périmée, suppressions et restauration, accès web sans jeton, droits FREE/PRO et interactions Chrome. Les essais avec une balance physique et les nouveaux paquets installés restent distincts de ces tests automatisés.
