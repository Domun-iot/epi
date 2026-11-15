# éPI

éPI reçoit les pesées Bluetooth de balances Xiaomi (service 181B) et de balances compatibles Weight Scale (service 181D, indication 2A9D).

| Version | Démarrage |
| --- | --- |
| Interface de release | `éPI.bat` sous Windows ou `sh éPI.sh` sous Linux |
| Interface en développement | `run\dev-éPI.bat` sous Windows ou `sh run/dev-éPI.sh` sous Linux |
| CLI de release | `run\cli.bat` sous Windows ou `sh run/cli.sh` sous Linux. Le lanceur reconstruit la release si elle manque ou si ses sources ou sa configuration de build sont plus récentes. |
| CLI en développement | `run\dev-cli.bat` sous Windows ou `sh run/dev-cli.sh` sous Linux |
| Web | `run\web.bat` sous Windows ou `sh run/web.sh` sous Linux. Depuis la release, lance `npm start`. |
| Tests CLI | `npm --prefix cli test` |
| Tests du domaine Tauri | `npm --prefix tauri test` |
| Tests interactifs | `npm --prefix tauri run test:ui` |

Les [tests de démarrage](docs/TEST-DEMARRAGE.md) couvrent les lanceurs et décrivent les essais sur les paquets installés.

## Version web

Lance `run\web.bat` ou `sh run/web.sh` depuis le dépôt. Le lanceur construit la version web si elle manque ou si ses sources sont plus récentes. Pour préparer ou construire manuellement, utilise `run\prep-web.bat` et `run\build-web.bat` sous Windows, ou `sh run/prep-web.sh` et `sh run/build-web.sh` sous Linux. Le build lance la préparation si son marqueur manque.

Copie le dossier `release/web/` sur le serveur Linux ou Windows, puis lance `npm start` depuis ce dossier. Node.js 20.19 ou supérieur et npm doivent être disponibles sur le serveur. La release contient le serveur et les fichiers statiques, sans installation npm à effectuer.

Édite `config.js` à la racine de la release et redémarre le serveur après modification.

```js
export default {
  host: '127.0.0.1',
  port: 3000,
  // dataDir: './data',
};
```

Un `dataDir` explicite et relatif est résolu depuis le dossier de `config.js`. Si `dataDir` est absent ou vide, le serveur utilise `EPI_DATA_DIR`, puis cherche un `data/` avec `devices/`, `measures/` et `profiles/` en remontant depuis la release. En dernier recours, il utilise le dossier utilisateur commun décrit ci-dessous. Le serveur crée le dossier de stockage et écrit `session.json` lors de la première modification. Un nouveau build conserve la configuration et les données. Utilise une seule instance du serveur par dossier de stockage et sauvegarde le dossier pour conserver les données.

Le serveur web lit et écrit `session.json` dans le dossier choisi. L’import et l’export ZIP permettent d’échanger profils, appareils et pesées avec les autres versions PC, qui utilisent des fichiers séparés. La capture Bluetooth reste disponible dans les applications installées. Les navigateurs connectés partagent le même espace de données. Le bouton « Recharger » récupère les changements effectués depuis un autre navigateur. Pour ouvrir l’accès sur le réseau, choisis l’interface d’écoute voulue. Pour un accès Internet, place le serveur derrière un proxy HTTPS avec authentification. Conserve l’écoute locale et configure le proxy pour transmettre l’en-tête `Host` de l’adresse locale.

## Données

Sur PC, le CLI et l’interface utilisent `EPI_DATA_DIR` quand la variable est définie. Sinon, ils cherchent un dossier `data/` contenant les trois sous-dossiers `devices/`, `measures/` et `profiles/`. La recherche commence à côté de l’exécutable ou de l’AppImage et remonte jusqu’à la racine.

Si aucun dossier partagé n’est trouvé, ils utilisent ou créent le dossier de données utilisateur commun. Sous Windows, c’est `%APPDATA%\fr.epi.balance\data`. Sous Linux, c’est `${XDG_DATA_HOME:-$HOME/.local/share}/fr.epi.balance/data`.

Sur mobile, Tauri utilise son répertoire privé. Les trois sous-dossiers et le JSON sont les mêmes sur toutes les plateformes. Le dernier profil chargé, le filtre BLE et les pesées en attente sont sauvegardés dans `data/prefs/global.json`. Les colonnes visibles et leur affichage groupé ou éclaté sont enregistrés dans `data/prefs/profil-<nom>.json` pour chaque profil personnalisé.

L’export prépare un ZIP avec les profils, appareils et pesées sous `data/`. L’import accepte cette arborescence ou `profiles/`, `devices/` et `measures/` placés directement à la racine. Les profils et les balances sont enregistrés sous leur UUID. Les nouvelles pesées sont classées dans le dossier UUID du profil et nommées selon leur horodatage UTC, par exemple `2026-11-15T06-47-43.567Z.json`. Chaque pesée conserve son propre UUID ainsi que les UUID associés dans `profile.uuid` et `device.uuid`, avec les informations disponibles au moment de la mesure. Si le dossier de profil et l’horodatage correspondent à une pesée déjà présente, l’import conserve le fichier existant. Les anciens noms de fichiers restent lisibles. Sur PC, si le CLI écrit pendant que l’interface est ouverte, recharge les données de l’interface ou redémarre-la pour lire ces changements.

Pour essayer l’historique, lance `run\fixture.bat` sous Windows ou `sh run/fixture.sh` sous Linux (Node.js requis). La fixture ajoute 48 pesées fictives sur 24 mois pour le profil `test`, avec 1 à 8 pesées par mois. Sur les six derniers mois de l’historique, le poids baisse progressivement d’environ 10 %, avec quelques remontées ponctuelles. La fixture conserve le profil et son historique s’ils existent déjà, et crée un appareil `test` seulement si aucun appareil n’est enregistré. Elle utilise le dossier de données habituel. Définis `EPI_DATA_DIR` pour générer le jeu dans un dossier distinct.

## Compiler

Sur un PC x64, choisis le script de préparation correspondant au build.

| Cible | Préparation |
| --- | --- |
| Windows 10/11 | `run\prep-windows.bat` |
| Ubuntu et AppImage sur une base Ubuntu/Debian | `sh run/prep-linux.sh` ou `sh run/prep-ubuntu.sh` |
| Android depuis Windows | `run\prep-android.bat` |
| Android depuis Ubuntu/Debian | `sh run/prep-android.sh` |
| CLI | `run\prep-cli.bat` sous Windows ou `sh run/prep-cli.sh` sous Linux |

La préparation de l’interface installe Node.js, Rust et les dépendances npm nécessaires. La préparation du CLI installe Node.js et vérifie sous Windows la présence du compilateur C# et des références WinRT. La préparation Android ajoute le JDK et le SDK/NDK et demande d’accepter les licences nécessaires. Sous Windows, elle vérifie aussi le Mode développeur et propose d’ouvrir les paramètres. Les composants système peuvent demander une élévation UAC sous Windows ou `sudo` sous Linux. Aucun installateur Git n’est lancé.

Tu peux lancer directement le script de build ou le lanceur de développement. Si le marqueur de sa cible manque dans `tmp/prep/`, le script lance la préparation correspondante. Chaque préparation vérifie les prérequis et réutilise ceux déjà installés. Elle enregistre son succès dans `tmp/prep/`, un dossier local ignoré par Git. Pour vérifier les prérequis à nouveau, relance le script de préparation ou supprime le marqueur de la cible avant le prochain build.

Les lanceurs `éPI.bat` et `sh éPI.sh` ouvrent le binaire autonome dans `release/windows/` ou `release/linux/`. S’il manque, ils exécutent le build de bureau avec `--portable`. Les deux lanceurs reconstruisent aussi le binaire lorsque les sources ou la configuration du build sont plus récentes. Les lanceurs `run\dev-éPI.bat` et `sh run/dev-éPI.sh` démarrent la version de développement via `tauri dev`.

| Plateforme | Génération | Résultat |
| --- | --- | --- |
| Windows | `run\build-windows.bat` | `release/windows/` contient `epi.exe` et les installateurs NSIS (EXE) et MSI. |
| Ubuntu | `sh run/build-ubuntu.sh` | `release/linux/` contient le binaire `epi` et le paquet `.deb`. |
| Linux, AppImage | `sh run/build-linux.sh` | `release/linux/` contient le binaire `epi` et l’AppImage. |
| Android | `run\build-android.bat` ou `sh run/build-android.sh` | `release/android/epi-debug.apk` |
| CLI | `run\build-cli.bat` ou `sh run/build-cli.sh` | `release/cli/windows/` ou `release/cli/linux/`. Un fichier par plateforme, `epi-cli.exe` sous Windows et `epi-cli` sous Linux, avec Node.js embarqué. Le scan Bluetooth du CLI est disponible sous Windows. |

Le lanceur de développement du CLI utilise Node.js pour exécuter les sources.

Sous Windows, active le [Mode développeur](https://learn.microsoft.com/windows/advanced-settings/developer-mode) pour permettre à Tauri de créer les liens symboliques de ses bibliothèques Android.

L’APK est signé avec la clé de débogage Gradle pour l’installation directe sur un téléphone. Le module Bluetooth requiert Android 8.0 ou plus récent.

Les lanceurs de bureau acceptent `--portable` pour compiler uniquement le binaire et un ou plusieurs noms de formats, par exemple `sh run/build-linux.sh rpm`.

L’AppImage se lance directement sur des distributions compatibles de même architecture. Tauri recommande de compiler sur la plus ancienne distribution que tu veux prendre en charge, par exemple Ubuntu 22.04 ou Debian 12. La version de glibc du poste de build peut exclure les distributions plus anciennes. Pour la balance Bluetooth, BlueZ doit être disponible sur le poste qui exécute éPI. [Limites de l’AppImage Tauri](https://v2.tauri.app/distribute/appimage/#limitations)

Sur Android, transfère l’APK sur le téléphone et ouvre-le depuis le gestionnaire de fichiers. Si Android le demande, autorise l’installation depuis ce gestionnaire. Lance éPI et accorde-lui l’autorisation Bluetooth. Le SDK fournit `adb` dans `platform-tools`, sous `%LOCALAPPDATA%\epi-dev\android-sdk` sur Windows ou `~/.local/share/epi-dev/android-sdk` sur Linux. Avec le débogage USB activé et le téléphone autorisé, utilise `adb install -r release/android/epi-debug.apk`. Pour Google Play, prépare un AAB signé pour la distribution.

Sur iOS, depuis `tauri/` sous macOS avec Xcode, lance `npm ci`, `npm run tauri -- ios init`, puis `npm run tauri -- ios build`. Accorde l’autorisation Bluetooth. CoreBluetooth identifie l’appareil par un UUID local. Sur un iPhone, associe de nouveau la balance si les fiches importées proviennent d’un PC.

La [documentation détaillée du CLI](cli/README.md) décrit les mesures, la réception et les méthodes de composition. Le [plan et l’inventaire](docs/SPECIFICATIONS.md) décrivent leur transposition dans l’interface.
