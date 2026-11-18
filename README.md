# éPI

éPI reçoit les pesées Bluetooth de balances Xiaomi, de balances compatibles Weight Scale et de plusieurs familles qui diffusent leurs mesures en BLE. Voir le [catalogue des balances et protocoles BLE](docs/BALANCES-BLE.md).

| Version | Démarrage |
| --- | --- |
| Tauri de release | `run\tauri.bat` sous Windows ou `sh run/tauri.sh` sous Linux. `éPI.bat` et `sh éPI.sh` restent disponibles à la racine. |
| Tauri en développement | `run\dev\tauri.bat` sous Windows ou `sh run/dev/tauri.sh` sous Linux |
| CLI de release | `run\cli.bat` sous Windows ou `sh run/cli.sh` sous Linux. Le lanceur reconstruit la release si elle manque ou si ses sources ou sa configuration de build sont plus récentes. |
| CLI en développement | `run\dev\cli.bat` sous Windows ou `sh run/dev/cli.sh` sous Linux |
| Web de release | `run\web.bat` sous Windows ou `sh run/web.sh` sous Linux. Depuis la release, lance `npm start`. |
| Web en développement | `run\dev\web.bat` sous Windows ou `sh run/dev/web.sh` sous Linux. Vite ouvre l’adresse locale dans le navigateur par défaut (port 1421 par défaut). |
| Tests CLI | `npm --prefix cli test` |
| Tests du domaine Tauri | `npm --prefix tauri test` |
| Tests interactifs | `npm --prefix tauri run test:ui` |

Les [tests de démarrage](docs/TEST-DEMARRAGE.md) couvrent les lanceurs et décrivent les essais sur les paquets installés.

## Version web

Lance `run\web.bat` ou `sh run/web.sh` depuis le dépôt. Le lanceur construit la version web si elle manque ou si ses sources sont plus récentes. Pour préparer ou construire manuellement, utilise `run\prep\web.bat` et `run\build\web.bat` sous Windows, ou `sh run/prep/web.sh` et `sh run/build/web.sh` sous Linux. Le build lance la préparation si son marqueur manque.

Sous Windows, le build web arrête les processus exécutant le fichier `tauri/node_modules/@esbuild/win32-x64/esbuild.exe` de ce dépôt avant `npm ci`, puis attend leur fin pour libérer le fichier.

Copie le dossier `release/web/` sur le serveur Linux ou Windows, puis lance `npm start` depuis ce dossier. Node.js 20.19 ou supérieur et npm doivent être disponibles sur le serveur. La release contient le serveur et les fichiers statiques, sans installation npm à effectuer.

Pour installer éPI depuis le navigateur, ouvre la version web en HTTPS ou en local sur `localhost`, puis utilise le menu du navigateur.

- Dans Chrome ou Edge sur ordinateur et Chrome sur Android, choisis **Installer** ou **Ajouter à l’écran d’accueil** selon la version.
- Dans Safari sur iPhone ou iPad, utilise **Partager → Sur l’écran d’accueil**, puis active **Ouvrir comme app web** si l’option est proposée.
- Dans Safari sur Mac (macOS Sonoma ou ultérieur), utilise **Fichier → Ajouter au Dock**.

L’application web installée se lance dans sa propre fenêtre et utilise toujours le serveur éPI pour accéder aux données.

Édite `config.js` à la racine de la release et redémarre le serveur après modification.

```js
export default {
  host: '127.0.0.1',
  port: 3000,
};
```

Un nouveau build conserve la configuration et les données. Pour reprendre un dossier personnalisé auparavant défini par `dataDir`, indique son chemin absolu dans `EPI_DATA_DIR` au lancement.

La release web personnelle et `dev-web` sélectionnent le même jeu de données que les autres versions PC. La capture Bluetooth reste disponible dans les applications installées. Sur une installation web personnelle, les navigateurs utilisent le jeu actif de cette installation. Le stockage distant du web public utilise une session PRO authentifiée et un dossier séparé pour chaque compte. Le bouton « Recharger » relit les fichiers, y compris après une modification dans Tauri ou le CLI. Pour ouvrir l’accès sur le réseau, choisis l’interface d’écoute voulue. La release personnelle ne doit pas être publiée directement sur Internet. Pour l’application publique multi-comptes, construire avec `node web/build.mjs --hosted`. La version hébergée permet aussi un usage anonyme dans le navigateur. FREE impose ce stockage local et ne partage aucune donnée entre navigateurs. Un compte PRO confirmé utilise directement l’API si ce navigateur n’a pas d’usage local mémorisé ; sinon, il conserve le stockage navigateur avec synchronisation PRO. Les [ports et adapters de stockage](docs/ARCHITECTURE-STOCKAGE.md) détaillent la sélection et les limites.

## Saisie manuelle

Dans les applications Tauri (PC et Android) et web, le bouton **Saisir** en haut à droite des mesures permet d’enregistrer un poids en kg ou lb, avec une date/heure modifiable et un pourcentage de masse grasse facultatif. La pesée appartient au profil actif. Sans profil, un poids seul est accepté ; renseigner la masse grasse ouvre la création du profil nécessaire aux calculs. La saisie est conservée pendant cette création.

Ces relevés utilisent le même stockage, les mêmes exports et la même synchronisation que les pesées Bluetooth. Leur section appareil indique « Saisie manuelle » : le JSON conserve `device.source: "manual"`, sans créer de balance dans la liste des appareils. Le pourcentage d’origine est conservé dans `measures.fatPercent`. Si l’impédance manque, les calculs recherchent une impédance équivalente pour retrouver ce pourcentage avec la moyenne habituelle des formules, arrondie à une décimale. La recherche est bornée à 1–3000 Ω et à 48 itérations par intervalle monotone. Une solution est enregistrée uniquement dans `calculations.impedanceOhms` ; une impédance réellement reçue reste prioritaire. Si aucune solution n’existe dans ces limites, le pourcentage est conservé et l’impédance calculée reste absente. Les autres méthodes et leurs moyennes ne sont pas remplacées par la valeur saisie.

## Données

Sur PC, le CLI, Tauri et le serveur web utilisent `EPI_DATA_DIR` quand la variable est définie avec un chemin absolu. Un chemin relatif est refusé pour éviter des jeux différents selon le dossier de lancement. Sinon, ils cherchent une racine `data/` reconnaissable par l’ancien jeu `devices/`, `measures/`, `profiles/`, le nouveau sous-dossier `local/`, les dossiers de comptes ou la configuration d’installation. La recherche remonte jusqu’à la racine depuis le dossier de l’exécutable, de l’AppImage ou du serveur web.

Si aucun dossier partagé n’est trouvé, ils utilisent ou créent le dossier de données utilisateur commun. Sous Windows, c’est `%APPDATA%\eu.domun.epi\data`. Sous Linux, c’est `${XDG_DATA_HOME:-$HOME/.local/share}/eu.domun.epi/data`.

La racine contient `local/` pour les données anonymes, `accounts/<UUID>/` pour chaque compte, et `installation.json` pour le compte actif et les préférences propres à l’installation. Les anciennes données à la racine migrent une fois vers `local/`, avec sauvegarde de récupération. Sur mobile, Tauri utilise son répertoire privé. Dans chaque jeu, les trois sous-dossiers et le JSON sont les mêmes sur toutes les plateformes. Sans compte, une première installation utilise ses données anonymes. Après rattachement, l’application mémorise le dernier compte actif et conserve son accès local hors connexion, même si le jeton expire. Une déconnexion explicite désélectionne ce jeu et impose une nouvelle connexion pour rouvrir l’application ; les données des comptes restent séparées. Les données anonymes peuvent être rattachées à un compte, avec choix de fusion/remplacement quand des données distantes existent en PRO. En FREE, elles restent locales : aucun transfert de synchronisation n’est effectué. Le dernier profil chargé, le filtre BLE et les pesées en attente sont sauvegardés dans `data/prefs/global.json`. Les colonnes visibles et leur affichage groupé ou éclaté sont enregistrés dans `data/prefs/profil-<nom>.json` pour chaque profil personnalisé.

Sur Tauri et sur le serveur web, le ZIP contient les fichiers de données sous `data/`, y compris les préférences globales et par profil, les configurations de vues, les notifications, le journal, la file d’envoi, les transactions entrantes, les transactions archivées et leur index lorsqu’ils existent. L’import fusionne les fichiers et les UUID avec les données locales en conservant les fichiers déjà présents. Les anciens ZIP avec les profils, appareils et pesées directement à la racine restent lisibles. Les profils et les balances sont enregistrés sous leur UUID. Les nouvelles pesées sont classées dans le dossier UUID du profil et nommées selon leur horodatage UTC, par exemple `2026-11-15T06-47-43.567Z.json`. Chaque pesée conserve son propre UUID ainsi que les UUID associés dans `profile.uuid` et `device.uuid`, avec les informations disponibles au moment de la mesure. Si le dossier de profil et l’horodatage correspondent à une pesée déjà présente, l’import conserve le fichier existant. Les anciens noms de fichiers restent lisibles. Sur PC, si le CLI écrit pendant que l’interface est ouverte, recharge les données de l’interface ou redémarre-la pour lire ces changements.

### Journal des transactions

Le CLI, Tauri et le serveur web ajoutent un fichier JSON à `data/transactions/` pour chaque écriture journalisée. Le nom associe un horodatage UTC et l’UUID. L’enveloppe contient `uuid`, `type` et `data`. Une opération `create` ou `update` contient le chemin relatif et le document JSON. Une opération `delete` contient le chemin. Une opération `batch` regroupe plusieurs opérations. Le fichier `data/transactions.index` contient les UUID, un par ligne.

La fonction Node.js `replayTransactions(dataDir)` de `shared/transactions.cjs` traite `data/transactions.incoming/` par ordre de nom. Elle archive les transactions inédites sous leur nom d’origine et retire les doublons de la file d’attente. Cette fonction traite la file de rejeu manuelle. Au démarrage, les versions Tauri et web connectées à un compte éPI récupèrent les transactions serveur dans leur ordre de création, archivent celles qu’elles intègrent dans `data/transactions.sent/` et accusent les UUID intégrés ou déjà présents. Si un arrêt forcé laisse `data/transactions.replay.lock`, supprime ce fichier après avoir vérifié que le rejeu est arrêté.

Le [fonctionnement de la synchronisation et ses cas limites](docs/SYNCHRONISATION.md) décrit le parcours des transactions entre installations, la portée des accusés et les problèmes à arbitrer.

Pour essayer l’historique, lance `run\fixture.bat` sous Windows ou `sh run/fixture.sh` sous Linux (Node.js requis). La fixture ajoute 48 pesées fictives sur 24 mois pour le profil `test`, avec 1 à 8 pesées par mois. Sur les six derniers mois de l’historique, le poids baisse progressivement d’environ 10 %, avec quelques remontées ponctuelles. La fixture conserve le profil et son historique s’ils existent déjà, et crée un appareil `test` seulement si aucun appareil n’est enregistré. Elle utilise le dossier de données habituel. Définis `EPI_DATA_DIR` pour générer le jeu dans un dossier distinct.

## Compiler

Sur un PC x64, choisis le script de préparation correspondant au build.

| Cible | Préparation |
| --- | --- |
| Windows 10/11 | `run\prep\windows.bat` |
| Ubuntu et AppImage sur une base Ubuntu/Debian | `sh run/prep/linux.sh` ou `sh run/prep/ubuntu.sh` |
| Android depuis Windows | `run\prep\android.bat` |
| Android depuis Ubuntu/Debian | `sh run/prep/android.sh` |
| CLI | `run\prep\cli.bat` sous Windows ou `sh run/prep/cli.sh` sous Linux |

La préparation de l’interface installe Node.js, Rust et les dépendances npm nécessaires. La préparation du CLI installe Node.js et vérifie sous Windows la présence du compilateur C# et des références WinRT. La préparation Android ajoute le JDK et le SDK/NDK et demande d’accepter les licences nécessaires. Sous Windows, elle vérifie aussi le Mode développeur et propose d’ouvrir les paramètres. Les composants système peuvent demander une élévation UAC sous Windows ou `sudo` sous Linux. Aucun installateur Git n’est lancé.

Tu peux lancer directement le script de build ou le lanceur de développement. Si le marqueur de sa cible manque dans `tmp/prep/`, le script lance la préparation correspondante. Chaque préparation vérifie les prérequis et réutilise ceux déjà installés. Elle enregistre son succès dans `tmp/prep/`, un dossier local ignoré par Git. Pour vérifier les prérequis à nouveau, relance le script de préparation ou supprime le marqueur de la cible avant le prochain build.

Les lanceurs `run\tauri.bat` et `sh run/tauri.sh` ouvrent le binaire autonome dans `release/windows/` ou `release/linux/`. S’il manque, ils exécutent le build de bureau avec `--portable`. Les deux lanceurs reconstruisent aussi le binaire lorsque les sources ou la configuration du build sont plus récentes. Les lanceurs `run\dev\tauri.bat` et `sh run/dev/tauri.sh` démarrent la version de développement via `tauri dev`.

| Plateforme | Génération | Résultat |
| --- | --- | --- |
| Windows | `run\build\windows.bat` | `release/windows/` contient `epi.exe` et les installateurs NSIS (EXE) et MSI. |
| Ubuntu | `sh run/build/ubuntu.sh` | `release/linux/` contient le binaire `epi` et le paquet `.deb`. |
| Linux, AppImage | `sh run/build/linux.sh` | `release/linux/` contient le binaire `epi` et l’AppImage. |
| Android | `run\build\android.bat` ou `sh run/build/android.sh` | `release/android/epi-debug.apk` |
| CLI | `run\build\cli.bat` ou `sh run/build/cli.sh` | `release/cli/windows/` ou `release/cli/linux/`. Un fichier par plateforme, `epi-cli.exe` sous Windows et `epi-cli` sous Linux, avec Node.js embarqué. Le scan Bluetooth du CLI est disponible sous Windows. |

Le lanceur de développement du CLI utilise Node.js pour exécuter les sources.

Sous Windows, active le [Mode développeur](https://learn.microsoft.com/windows/advanced-settings/developer-mode) pour permettre à Tauri de créer les liens symboliques de ses bibliothèques Android.

Le build Android Windows place le cache Rust dans `%LOCALAPPDATA%\epi-dev\cargo-target\android\<identifiant-du-dépôt>`, pour éviter les erreurs du linker NDK lorsque le chemin du dépôt contient un accent, comme `éPI`. Chaque emplacement du dépôt possède son propre cache. Le lanceur autorise également ce chemin dans Gradle avec `android.overridePathCheck=true`. Tu peux choisir un autre dossier avec `CARGO_TARGET_DIR` ; son chemin absolu doit contenir uniquement des caractères ASCII.

Sans option, l’APK est signé avec la clé de débogage Gradle. Pour un APK de production, utiliser `run\build\android.bat --release` (ou `sh run/build/android.sh --release`), puis `run\build\sign-android.ps1` sous Windows : le fichier installable est `release/android/epi-release.apk`. La création des artefacts et la signature locale sont décrites dans le [guide de build](docs/BUILD.md). Le module Bluetooth requiert Android 8.0 ou plus récent.

Sous Linux, `sh run/build/all.sh` construit successivement l’AppImage, le paquet Ubuntu `.deb`, Android, le CLI, le Web et le serveur. Il poursuit après une erreur, affiche le bilan de chaque cible et retourne un code d’échec si au moins une cible échoue. Sous Windows, utilise `run\build\all.bat`.

Les lanceurs de bureau acceptent `--portable` pour compiler uniquement le binaire et un ou plusieurs noms de formats, par exemple `sh run/build/linux.sh rpm`.

L’AppImage se lance directement sur des distributions compatibles de même architecture. Tauri recommande de compiler sur la plus ancienne distribution que tu veux prendre en charge, par exemple Ubuntu 22.04 ou Debian 12. La version de glibc du poste de build peut exclure les distributions plus anciennes. Pour la balance Bluetooth, BlueZ doit être disponible sur le poste qui exécute éPI. [Limites de l’AppImage Tauri](https://v2.tauri.app/distribute/appimage/#limitations)

Sur Android, transfère l’APK sur le téléphone et ouvre-le depuis le gestionnaire de fichiers. Si Android le demande, autorise l’installation depuis ce gestionnaire. Lance éPI et accorde-lui l’autorisation Bluetooth. Le SDK fournit `adb` dans `platform-tools`, sous `%LOCALAPPDATA%\epi-dev\android-sdk` sur Windows ou `~/.local/share/epi-dev/android-sdk` sur Linux. Avec le débogage USB activé et le téléphone autorisé, utilise `adb install -r release/android/epi-debug.apk`. Pour produire un AAB Android, utilise le build `--play` décrit dans le [guide de build](docs/BUILD.md).

Sur iOS, depuis `tauri/` sous macOS avec Xcode, lance `npm ci`, `npm run tauri -- ios init`, puis `npm run tauri -- ios build`. Accorde l’autorisation Bluetooth. CoreBluetooth identifie l’appareil par un UUID local. Sur un iPhone, associe de nouveau la balance si les fiches importées proviennent d’un PC.

La [documentation détaillée du CLI](cli/README.md) décrit les mesures, la réception et les méthodes de composition. Le [plan et l’inventaire](docs/SPECIFICATIONS.md) décrivent leur transposition dans l’interface.
