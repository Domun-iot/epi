# éPI

éPI collecte les données Bluetooth Low Energy (BLE) des appareils à proximité. La version actuelle prend en charge les pesées. Il écoute les annonces Bluetooth de la Xiaomi (`0x181B`) et peut se connecter aux balances qui annoncent le service GATT Weight Scale (`0x181D`) pour recevoir la caractéristique Weight Measurement (`0x2A9D`).

## Démarrer

Sous Windows 10 ou 11 (64 bits), avec Node.js 20 ou plus et le Bluetooth activé :

```powershell
node index.cjs
```

Aucune dépendance npm à installer. Node compile le petit lecteur C# avec le compilateur .NET Framework fourni par Windows et le lance dans un dossier temporaire. Le lecteur accède à l'[API Bluetooth LE de Windows](https://learn.microsoft.com/en-us/windows/uwp/devices-sensors/ble-beacon).

Attends « Écoute Bluetooth active », puis monte sur la balance à proximité du PC. Reste pieds nus sur les électrodes jusqu'à la fin de la mesure si tu veux récupérer l'impédance. Quitte avec Ctrl+C.

Le programme enregistre automatiquement un relevé par lancement dans `data/measures/<profil>/AAAA-MM-JJ-HH-MM-SS.json`, y compris en mode `--raw`. Le nom du fichier est en UTC. Les relevés reçus dans la même seconde prennent un suffixe (`-2`, `-3`, etc.). Chaque fichier contient `receivedAt` (heure de réception du PC en UTC), `profile`, `device` (copie de la fiche de la balance), puis `measures` (poids, unité et impédance), `calculations` et enfin `reception`. Cette section commence par `raw.hex` (octets de la charge utile Xiaomi dans leur ordre d’origine), puis contient `bluetooth` (`serviceUuid`, nom `service`, adresse de provenance et puissance `rssiDbm`) et `scale` (poids stabilisé `stable`, charge retirée `removed` et horloge de la balance `scaleTime`). Les données indisponibles dans les anciens relevés valent `null`. Un profil temporaire sans nom utilise le dossier `_sans-profil`. Un premier relevé avec impédance est enregistré immédiatement. Un relevé Weight Scale est enregistré dès réception. Pour la Xiaomi, un relevé sans impédance attend jusqu’à quinze secondes avant d’être écrit. Si un relevé avec impédance arrive dans ce délai avec la même adresse, le même horodatage de balance, le même poids et la même unité, seul le relevé complet est enregistré. Il écarte les annonces qui suivent le retrait de la charge et regroupe les mesures identiques pour une même adresse et un même horodatage de la balance dans une fenêtre glissante de 30 secondes. À l’expiration du délai, le programme enregistre le poids seul si nécessaire. Il rend la main dès que la pesée est enregistrée.

- `weight` et `unit` : poids et unité émise (`kg` ou `lb`).
- `impedanceOhms` : impédance en ohms, ou `null` si elle n'est pas disponible. Les pourcentages de graisse ou de muscle ne sont pas dans ces annonces.
- `receivedAt` : date de réception du PC en UTC. `scaleTime` est l'horloge embarquée, sans fuseau ; elle peut ne pas être à l'heure.
- `address` et `rssi` : adresse Bluetooth et puissance du signal en dBm.

```powershell
node index.cjs --seconds 30
node index.cjs --mac AA:BB:CC:DD:EE:FF
node index.cjs --raw --seconds 30
node index.cjs > sortie-console.txt
npm test
```

`--raw` montre les trames du service `0x181B`, y compris celles en cours de pesée et les doublons. En cas de silence, vérifie que le Bluetooth est activé, rapproche la balance et relance une pesée. Si l'application du téléphone se connecte à la balance, ferme-la le temps de l'essai.

## Enregistrer ou sélectionner une balance

```powershell
node index.cjs -d "Salle de bain"
node index.cjs Malik --appareil "Salle de bain"
```

La première pesée faite avec un nouveau nom crée une fiche dans `data/devices/`. Utilise uniquement la nouvelle balance pendant cet enregistrement. Quand le nom existe déjà, seules les annonces de son adresse Bluetooth sont acceptées. Sans option, le programme reconnaît les balances enregistrées par leur adresse. Si la pesée provient d’une balance inconnue, il demande son nom après réception, avant de demander le profil utilisateur. Les réponses BLE enrichissent la fiche par adresse Bluetooth. Le nom annoncé et les identifiants fabricant sont mis à jour quand ils sont reçus. La pesée conserve une copie de la fiche au moment de l’écriture. La table des fabricants est générée depuis Nordic Bluetooth Numbers Database, avec sa notice BSD-3-Clause dans licenses/. Le modèle Xiaomi est déduit du nom `MIBFS` et de l’identifiant Huami. Chaque mesure stable distincte est signalée dans le terminal avec le nom de la balance ou son adresse, et l’impédance lorsqu’elle est disponible. `--mac` peut restreindre l’écoute à une adresse connue à l’avance.

La fiche contient l’adresse, le service BLE, le nom annoncé s’il figure dans la trame et le type d’annonce. Le service et le nom annoncé ne suffisent pas à distinguer deux balances identiques. Si une balance change d’adresse, il faut l’enregistrer sous un nouveau nom. Le RSSI reste une donnée de réception de chaque pesée.

## Comparer les estimations de composition

```powershell
node index.cjs Camille --sexe F --naissance 15/06/1991 --taille 170
node index.cjs cam
node index.cjs Camille --taille 171
node index.cjs
```

Les options acceptent les formes suivantes.

| Paramètre | Options |
| --- | --- |
| Utilisateur | `-u`, `--user`, `--utilisateur` |
| Sexe | `-s`, `--sex`, `--sexe` |
| Âge | `-a`, `--age`, `--âge` |
| Date de naissance | `-b`, `-n`, `--birthdate`, `--birthday`, `--birth`, `--naissance` |
| Taille | `-t`, `--height`, `--taille` |
| Aide | `-h`, `--help`, `--aide` |

Les profils sont conservés dans `data/profiles/`. Le nom peut être donné sans option et abrégé avec un préfixe qui ignore la casse et les accents. Le terminal propose un choix si le nom est ambigu ou introuvable. Si le nom est introuvable, tape `0` pour créer le profil avec ce nom. Tu peux aussi fournir ses informations en arguments. La date de naissance accepte `JJ/MM/AAAA` ou `AAAA-MM-JJ`. Tu peux aussi saisir un âge fixe. Avec une date de naissance, l’âge est calculé à la date de chaque pesée en heure de Paris et enregistré avec les résultats. Si un profil est incomplet, le programme demande les valeurs manquantes dans le terminal avant d’ouvrir le Bluetooth. Hors terminal interactif, il indique quels paramètres ajouter. Les trois caractéristiques peuvent aussi être fournies sans nom pour une seule session.

Le tableau de la pesée retenue affiche une donnée par ligne et une méthode par colonne. Le poids et l’impédance sont signalés dès leur réception. Le mode `--raw` affiche les trames en JSON. Un profil passé en argument s’applique à toute la session. Sans argument de profil, le programme compare le poids au dernier relevé de chaque profil et choisit le plus faible écart en pourcentage parmi les profils à ±10 %. Si aucun ne correspond, il liste les profils et propose aussi `0. Créer un profil`. Tape `0`, puis renseigne le nom, le sexe, la date de naissance ou l’âge, et la taille. La pesée en cours est enregistrée sous ce nouveau profil. Le relevé enregistré devient la nouvelle référence du profil. La table locale `bluetooth-services.json` reprend les services GATT standard de la section 3.4 du [registre du Bluetooth SIG](https://www.bluetooth.com/specifications/assigned-numbers/).

| Colonne | Méthode | Données nécessaires |
| --- | --- | --- |
| IMC | Poids divisé par la taille au carré | Poids, taille |
| Mi | Formules communautaires [Mi Fit](https://github.com/lolouk44/xiaomi_mi_scale/blob/master/src/Xiaomi_Scale_Body_Metrics.py), avec les seuils du code source | Poids, taille, âge, sexe et, selon la ligne, impédance |
| Sun* | [Sun et al. (2003)](https://pubmed.ncbi.nlm.nih.gov/12540391/), masse maigre et eau totale | Poids, taille, sexe, impédance |
| Jan* | [Janssen et al. (2000)](https://pubmed.ncbi.nlm.nih.gov/10926627/), muscle squelettique | Taille, âge, sexe, impédance |
| D60* | [Deurenberg et al. (1990)](https://www.inner-image.com/assets/2015/05/4.-Deurenberg-van-der-Kooij-Evers-Hulshof-1990.pdf), masse maigre après 60 ans | Poids, taille, sexe, impédance |
| Deu | [Deurenberg et al. (1991)](https://pubmed.ncbi.nlm.nih.gov/2043597/), formule adulte de masse grasse | IMC, âge, sexe |
| CUN | [Gómez-Ambrosi et al. (2012)](https://pubmed.ncbi.nlm.nih.gov/22179957/), CUN-BAE | IMC, âge, sexe |
| Wat | [Watson et al. (1980)](https://doi.org/10.1093/ajcn/33.1.27), eau totale | Poids, taille, âge, sexe |
| HW | [Hume et Weyers (1971)](https://pmc.ncbi.nlm.nih.gov/articles/PMC476961/), eau totale | Poids, taille, sexe |
| MSJ | [Mifflin–St Jeor et al. (1990)](https://doi.org/10.1093/ajcn/51.2.241), dépense au repos | Poids, taille, âge, sexe |
| HB | [Roza et Shizgal (1984)](https://pubmed.ncbi.nlm.nih.gov/6741850/), révision de Harris–Benedict | Poids, taille, âge, sexe |
| Owe | Owen et al., dépense au repos selon le poids pour les [hommes](https://pubmed.ncbi.nlm.nih.gov/3687821/) et les [femmes non athlètes](https://pubmed.ncbi.nlm.nih.gov/3728346/) | Poids, sexe |
| Cun* | [Cunningham (1980)](https://pubmed.ncbi.nlm.nih.gov/7435418/), dépense au repos estimée à partir de la masse maigre de Sun | Masse maigre Sun |

Ces comparaisons sont destinées aux adultes. Dans les colonnes marquées d’un astérisque, l’impédance Xiaomi pieds à pieds remplace la résistance mesurée avec les appareils de référence. Cette substitution n’a pas été validée pour ce modèle de balance. La masse musculaire Mi Fit et le muscle squelettique Janssen sont affichés sur deux lignes, car les modèles estiment des grandeurs différentes. Le score viscéral Mi Fit est sans unité et dépend du poids et du profil. L’âge métabolique et les protéines sont des estimations communautaires. Les valeurs osseuses ne donnent pas une densité minérale. Des formules comme [Kyle et al.](https://www.sciencedirect.com/science/article/pii/S0899900700005530) demandent la réactance, absente de la trame Bluetooth.

Le décodage s'appuie sur le [code ESPHome](https://github.com/esphome/esphome/blob/dev/esphome/components/xiaomi_miscale/xiaomi_miscale.cpp) et est vérifié avec une [capture réelle de la XMTZC05HM](https://github.com/lolouk44/hassio-addons/issues/14).
