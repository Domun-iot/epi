# Spécifications éPI Tauri 2

## Inventaire CLI

| Fonction CLI | Interface Tauri |
| --- | --- |
| Scanner Windows, annonces Xiaomi et indications GATT, messages d’état | Écoute continue dès le lancement, via le Bluetooth natif |
| Pesées stables uniquement, trames déchargées et doublons écartés, 15 s d’attente de l’impédance Xiaomi, GATT immédiat | Même décodage et règles, pour plusieurs pesées par lancement |
| `--mac` ou appareil nommé, identification BLE `--identify`, trames `--raw`, enregistrement JSON | Filtre d’adresse, liste d’appareils et journal Bluetooth, historique et détail des trames |
| `--seconds`, aide et redirection de la sortie | Options propres au terminal. L’interface reste ouverte et propose le détail des données ainsi que l’export ZIP |
| Création de fiche par nom ou après détection, reconnaissance par adresse, enrichissement BLE et modèle de balance | Création et actualisation par pesée reçue, édition du nom affiché, champs issus du Bluetooth en lecture seule |
| Choix du profil par nom, préfixe sans casse ni accents, clarification interactive, profil imposé par argument | Sélecteur de profil, choix mémorisé et utilisé pour l’affichage |
| Création et modification du sexe utilisé par les formules, date de naissance ou âge entier, taille, profil de session sans nom | Formulaire de profil, nom de fiche conservé pour maintenir le lien avec l’historique. Attribution manuelle des pesées sans correspondance |
| Plus proche dernier poids à ±10 %, proposition de choisir ou créer un profil | Même règle automatique. La sélection bascule vers le profil identifié ou confirmé |
| Poids en kg/lb, impédance, date locale/UTC, provenance et trame brute, copie instantanée de la fiche, comparaison des 13 méthodes | Historique du profil avec date et poids fixes, choix des colonnes, méthodes côte à côte avec icône et couleur, accès aux éléments de réception |
| Fichiers JSON de profils, balances et mesures horodatées, suffixe en cas de collision | Répertoire et formats partagés sur PC, stockage privé sur mobile, fusion et sauvegarde ZIP |

Les estimations affichées réutilisent les valeurs déjà écrites dans chaque pesée. Une modification du profil s’applique aux futures pesées. Les méthodes IMC, Mi, Sun, Janssen, Deurenberg 1990/1991, CUN-BAE, Watson, Hume–Weyers, Mifflin–St Jeor, Harris–Benedict, Owen et Cunningham gardent les calculs du CLI.

## Développement et vérification

1. Isoler le CLI dans `cli/`. Déplacer en modules communs le décodage, les métadonnées, les profils et les calculs. Vérifier la suite du CLI et l’aide.
2. Implémenter l’acquisition et l’attribution dans un domaine JavaScript indépendant de l’interface, avec stockage injecté. Simuler Xiaomi et GATT, la stabilisation, l’enregistrement, l’identification, les nouvelles fiches et les erreurs de stockage.
3. Brancher le Bluetooth dans Tauri par plateforme, lier l’interface et les JSON CLI via IPC, puis tester le stockage et la fusion ZIP.
4. Tester dans un navigateur les parcours de gestion, la confirmation manuelle et automatique, la persistance, les colonnes et la mise en page mobile.
5. Vérifier le build par cible et lancer les essais physiques avec les balances en dernier.
