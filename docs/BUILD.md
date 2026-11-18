# Développer et construire éPI

Ce dépôt contient le CLI, l'application Tauri, le client web, l'API de synchronisation
et le site de présentation. Les paiements sont traités par un service externe.
Cette documentation couvre les sources, les tests et les artefacts locaux.

## Prérequis

Cloner le dépôt et lancer les commandes depuis sa racine. Node.js 24 permet de
travailler sur toutes les parties JavaScript ; le serveur exige au moins 22.13
(`node:sqlite`), le web/Tauri au moins 20.19. Les fichiers de verrouillage npm et
Cargo sont versionnés. Utiliser `npm ci` pour reproduire les dépendances.

Les scripts `run/prep/` préparent Node.js, Rust, les dépendances système et les
outils Android selon la cible. Lire les scripts avant exécution : ils peuvent
installer des outils et demander sudo ou UAC. Les marqueurs sont dans `tmp/prep/`.

| Cible | Préparation Windows | Préparation Linux |
| --- | --- | --- |
| Interface desktop | `run\prep\windows.bat` | `sh run/prep/linux.sh` ou `sh run/prep/ubuntu.sh` |
| Android | `run\prep\android.bat` | `sh run/prep/android.sh` |
| CLI | `run\prep\cli.bat` | `sh run/prep/cli.sh` |
| Web | `run\prep\web.bat` | `sh run/prep/web.sh` |
| API | `run\prep\server.bat` | `sh run/prep/server.sh` |

## Développement et tests

Les lanceurs `run/dev/{cli,tauri,web,server}.sh` et leurs équivalents `.bat`
démarrent les versions de développement. Le CLI scanne le Bluetooth sous Windows.
Le client web permet de développer les écrans sans acquisition Bluetooth.
`www/` se lance indépendamment avec `npm --prefix www start`.

```sh
npm --prefix cli test
npm --prefix tauri test
npm --prefix tauri run test:ui
npm --prefix server test
npm --prefix www test
node --test shared/*.test.cjs shared/scales/*.test.cjs web/*.test.js
```

Les tests d'interface utilisent Playwright et Chromium. Installer le navigateur
de test avec `cd tauri && npx playwright install chromium` si nécessaire, puis
revenir à la racine. Les tests locaux remplacent les services de compte et de
catalogue par des doublures. Les clients applicatifs configurent le service de
compte dans `tauri/src/service.js` ; vérifier cette configuration avant un essai
manuel. Utiliser uniquement des profils fictifs et un dossier temporaire pour les essais.

## Configuration locale des services

Les valeurs par défaut sont destinées au développement : API sur 8787 (dans
`server/config.js`), web personnel sur 3000 (`web/config.js`), fichiers du client
hébergé sur 3001 (`EPI_WEB_PORT`) et site de présentation sur 3002 (`EPI_WWW_PORT`).
Pour le client hébergé, fournir la même valeur de `EPI_WEB_PORT` au processus API
et au serveur des fichiers statiques. Les paramètres propres à une installation
et les outils d'exploitation sont conservés hors de ce dépôt public.

## Artefacts par cible

| Cible | Commande | Sortie |
| --- | --- | --- |
| Windows desktop | `run\build\windows.bat` | `release/windows/` : EXE, MSI, binaire autonome |
| Linux DEB | `sh run/build/ubuntu.sh` | `release/linux/` : binaire et DEB |
| Linux AppImage | `sh run/build/linux.sh` | `release/linux/` : binaire et AppImage |
| CLI | `sh run/build/cli.sh` ou `run\build\cli.bat` | `release/cli/<plateforme>/epi-cli[.exe]` |
| Web personnel | `sh run/build/web.sh` ou `run\build\web.bat` | `release/web/` |
| Client web hébergé | `node web/build.mjs --hosted` | `release/web/` avec adapter hébergé |
| API | `sh run/build/server.sh` ou `run\build\server.bat` | `server/dist/` |
| Android debug | `sh run/build/android.sh` ou `run\build\android.bat` | `release/android/epi-debug.apk` |
| Android release | mêmes scripts avec `--release` | `release/android/epi-release-unsigned.apk` |
| Android AAB | mêmes scripts avec `--play` | `release/android/epi-play.aab` |

Les scripts desktop acceptent `--portable` pour ne produire que le binaire.
Le lanceur Linux accepte les formats `deb`, `rpm`, `appimage` ; le lanceur Windows
accepte `nsis`, `msi`. Construire sur le système cible avec ses outils natifs.
`sh run/build/all.sh` et `run\build\all.bat` parcourent les cibles de leur système
et affichent un bilan ; une cible en échec ne valide pas ses anciens artefacts.

Le build Android utilise JDK 17, SDK Android, NDK et Rust. Les variantes release
incluent ARM64 et x86-64. Un build debug utilise la signature de développement Gradle.
Le build desktop Linux exige les dépendances WebKit/GTK et Bluetooth décrites par
les scripts de préparation. Le binaire CLI Linux ne fournit pas le scan Windows.

## Signature locale Android

Un APK release doit être signé avant installation. Garder la clé et son mot de
passe hors du dépôt ; sauvegarder les deux dans un coffre indépendant.
Une mise à jour exige la même clé de signature que l'installation existante.

Sous Windows, `run\build\sign-android.ps1` utilise un magasin PKCS12 dans
`%USERPROFILE%\epi-keys`, alias `epi-upload`, et un fichier de mot de passe protégé
par DPAPI. `-KeyDirectory` sélectionne un autre répertoire. Pour créer sa propre
clé, adapter l'identité publique `-dname` du script, puis utiliser `-CreateKey`
une seule fois. Réutiliser ensuite la même clé. Le XML DPAPI n'est lisible que par
le même utilisateur sur le même ordinateur ; il ne remplace pas une sauvegarde portable.
Le script vérifie la signature APK, l'alignement ZIP et la signature AAB.

Sous Linux, créer sa propre clé hors du dépôt et utiliser les outils du JDK et du
SDK Android. Exemple avec un mot de passe demandé par les outils :

```sh
keytool -genkeypair -storetype PKCS12 -keystore /chemin/prive/upload.p12 -alias epi-upload -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Example Developer'
zipalign -f -P 16 4 release/android/epi-release-unsigned.apk release/android/epi-release-aligned.apk
apksigner sign --ks /chemin/prive/upload.p12 --ks-key-alias epi-upload --out release/android/epi-release.apk release/android/epi-release-aligned.apk
apksigner verify --verbose --print-certs release/android/epi-release.apk
zipalign -c -P 16 4 release/android/epi-release.apk
jarsigner -keystore /chemin/prive/upload.p12 -signedjar release/android/epi-play-signed.aab release/android/epi-play.aab epi-upload
jarsigner -verify release/android/epi-play-signed.aab
```

Ajouter le JDK et le répertoire SDK `build-tools/<version>` au PATH.
Le nom de certificat ci-dessus est fictif. Ne jamais placer un mot de passe dans
une commande versionnée ni remplacer une clé existante pour reconstruire.

## macOS et iOS

Les lanceurs desktop fournis ciblent Windows et Linux. Sur macOS, utiliser la CLI
Tauri depuis `tauri/`, avec Rust, Xcode et les outils Apple :

```sh
cd tauri
npm ci
npm run tauri -- build
npm run tauri -- ios init
npm run tauri -- ios build
```

La cible iOS nécessite une configuration de signature Apple propre au développeur.
Ces commandes ne constituent pas une validation matérielle : contrôler le support
Bluetooth et les autorisations sur l'appareil cible. Voir aussi [TEST-DEMARRAGE.md](TEST-DEMARRAGE.md).

## Architecture et licence

Voir [README](../README.md), [CLI](../cli/README.md), [API](../server/README.md),
[stockage](ARCHITECTURE-STOCKAGE.md), [comptes](COMPTES-ET-DONNEES.md),
[synchronisation](SYNCHRONISATION.md) et [protocoles BLE](BALANCES-BLE.md).
Le code original éPI est distribué sous LGPL-3.0-only ; les ressources tierces
conservent leurs licences et leurs attributions. Voir [LICENSE](../LICENSE).
