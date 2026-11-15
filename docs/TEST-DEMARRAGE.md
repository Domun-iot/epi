# Vérifier le démarrage d’éPI

Depuis la racine du dépôt, lance `node scripts/test-launchers.cjs`. Le test exécute les lanceurs de production de la plateforme dans des dossiers temporaires dont le chemin contient des espaces. Il couvre le binaire absent, à jour ou périmé, ainsi que l’échec d’un build avec un ancien binaire encore présent. Il vérifie le dossier de démarrage, la transmission d’un argument contenant des espaces et le code de sortie du CLI. La fixture doit produire 48 pesées et conserver ce total au second lancement.

Pour exercer aussi les scripts shell sous Windows, utilise Git Bash avec `$env:EPI_SMOKE_BASH = 'C:/Program Files/Git/bin/bash.exe'` avant de relancer la commande. Les exécutables et les builds de cette suite sont simulés.

## Essai sur un poste Linux

1. Dans un terminal, crée un dossier de données séparé avec `export EPI_DATA_DIR="$(mktemp -d)"`, puis lance `sh run/fixture.sh`.
2. Lance `sh éPI.sh`, puis ferme l’application et lance `sh run/dev-tauri.sh`. Dans chaque fenêtre, vérifie les styles dès l’ouverture, sélectionne le profil `test` et vérifie les 48 pesées.
3. Lance `sh run/cli.sh --help` et `sh run/dev-cli.sh --help`. Chaque commande doit afficher l’aide et sortir avec le code 0.
4. Installe le paquet `.deb` ou lance l’AppImage sur une distribution compatible. Vérifie le démarrage depuis un dossier extérieur au dépôt avec le même `EPI_DATA_DIR`, puis ouvre le profil de test.

## Paquets et balance

- Sous Windows, valide le MSI ou le programme NSIS sur un poste ou une VM de test. Ouvre éPI depuis son raccourci, importe un ZIP de données de test et vérifie les styles et les 48 pesées.
- Sur un appareil Android de test, installe l’APK avec `adb install -r release/android/epi-debug.apk`. Ouvre éPI depuis le lanceur Android, accepte les permissions Bluetooth, importe le ZIP de test et vérifie le même profil.
- Sous Windows, lance `run\cli.bat --identify --seconds 30`, puis `run\dev-cli.bat --identify --seconds 30`. Réveille la balance pendant chaque écoute et vérifie qu’une annonce correspond à la balance. Le mode identification permet de vérifier la réception sans enregistrer de pesée.
