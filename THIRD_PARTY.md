# Crédits et licences des composants éPI

Le code original éPI est sous LGPL-3.0-only. Les composants et ressources tiers
conservent leurs notices et leurs licences respectives, disponibles dans `licenses/`
ou auprès des dépendances verrouillées.

## Composition corporelle

Les formules communautaires Mi et leurs paramètres sont adaptés de
[lolouk44/xiaomi_mi_scale](https://github.com/lolouk44/xiaomi_mi_scale/tree/e9db989d21b23602a462338a285478658cbaa137),
© 2020 lolouk44, sous [MIT](licenses/xiaomi_mi_scale-MIT.txt).
Les travaux amont créditent également syssi et prototux/wiecosystem.
Le solveur numérique de `shared/estimated-impedance.cjs` est une contribution éPI.

Les méthodes Sun, Janssen, Deurenberg, CUN-BAE, Watson, Hume–Weyers,
Mifflin–St Jeor, Harris–Benedict, Owen et Cunningham implémentent les équations
publiées par leurs auteurs. Les références bibliographiques et liens par méthode
sont dans le [guide du CLI](cli/README.md#comparer-les-estimations-de-composition)
et dans l'interface. L'IMC correspond à la relation poids/taille².

## Protocoles Bluetooth

Le [catalogue technique BLE](docs/BALANCES-BLE.md) donne les modèles, formats,
captures et références utilisés pour le développement et les vérifications.

| Famille | Travaux et références techniques |
| --- | --- |
| Xiaomi composition | IPanalytics ([MIT](licenses/xiaomi-scale-reverse-engineering-MIT.txt)), ESPHome, Theengs, captures lolouk44 |
| Xiaomi poids | Bluetooth-Devices/xiaomi-ble (Apache-2.0), passcod, Theengs |
| Weight Scale | Bluetooth SIG, Weight Scale Service et Weight Measurement |
| QN | openScale/olie.xdev et lanrat ; asd333111 ([MIT](licenses/bluetooth_scale-MIT.txt)) |
| Yunmai X | openScale et imconical |
| PICOOC Mini Lite | openScale et dnsfdv |
| Etekcity Fit 8S | Ron Ben Yosef ([MIT](licenses/etekcity_esf551_ble-MIT.txt)), basjam, openScale et BLE Scale Sync |
| Scale Up | openScale, ScaleupHandler |
| Silvergear/Fitdays | openScale AAAxHandler, KristianP26/BLE Scale Sync, beatXP |
| AiLink EL1 | openScale AiLinkLib ; Wheeler et Needham pour TEA |
| Senssun IF_B7 | KristianP26/BLE Scale Sync et contributeur de la capture #423 |
| OKOK | openScale, BLE Scale Sync, Mohan Narayana Mondi/Fitelo ([MIT](licenses/fitelo-debug-app-MIT.txt)) |
| Eufy | Brandon Rothweiler, EufyLife BLE Client (MIT déclaré par le projet) |

Les fixtures synthétiques AiLink présentes dans les tests sont produites pour éPI
à partir de champs choisis et de l'encodage TEA. Les autres captures conservent
les références et crédits mentionnés dans leurs tests.

## Tables de fabricants et de services

Les tables hors ligne sont produites par
[`scripts/rebuild-bluetooth-catalogs.py`](scripts/rebuild-bluetooth-catalogs.py).
Les entrées, révisions, empreintes et règles de présentation sont enregistrées
avec les sources de configuration dans `scripts/catalogs/` et dans
[`shared/bluetooth-catalog-provenance.json`](shared/bluetooth-catalog-provenance.json).

| Contribution | Révision | Licence et notice |
| --- | --- | --- |
| Nordic Semiconductor, Bluetooth Numbers Database | `5c795f597125b7be0d5033fb648e9b6f5e09d9c9` | [BSD-3-Clause](licenses/nordic-bluetooth-numbers-BSD-3-Clause.txt), © 2019–2020 Nordic Semiconductor ASA |
| PureSwift/Bluetooth, métadonnées UUID | `033e52c56ce97ae4232ebb0b91522dbe385582d3` | [MIT](licenses/pureswift-bluetooth-MIT.txt), texte amont conservé |
| BlueZ, table UUID de src/shared/util.c | `923d95d0c2fb001b545fa8a8b2e3a8a9bf0dbabf` | [LGPL-2.1-or-later](licenses/bluez-LGPL-2.1.txt), Intel et NXP, en-tête amont conservé dans la notice |

La table des fabricants contient 4 075 identifiants sélectionnés dans Nordic.
Le catalogue de services conserve 820 identifiants et leurs libellés d'affichage.
Les compléments et variantes d'affichage sont maintenus dans
`scripts/catalogs/supplementary-services.json` et `service-display-names.json`.

Les 58 356 préfixes MAC proviennent des registres IEEE MA-L, MA-M, MA-S et IAB,
référence du 15 novembre 2026. Attribution : IEEE Registration Authority.
Les données des registres sont distinctes des scripts de conversion et du code éPI.

## Dépendances et ressources

Les versions sont verrouillées dans les trois `package-lock.json` et dans
`tauri/src-tauri/Cargo.lock`. Les licences et notices des composants restent
applicables selon leur distribution : Tauri et ses plugins, serde, chrono,
Tokio, btleplug, fflate, Node.js et ses composants embarqués, AndroidX, Kotlin,
Material Components, Jackson et Guava notamment. Les sources MPL, textes Apache,
NOTICE, licences Unicode et autres notices des paquets doivent accompagner les
éléments concernés. Les outils de développement comprennent Vite, esbuild,
postject, Playwright, TypeScript et les types Node.

Les builds joignent les notices des sources éPI et du frontend dans `legal/`.
Le CLI y ajoute le fichier de licence complet de la distribution Node incorporée.
Les versions npm et l'empreinte de cette licence sont dans `components.json`.

L'icône Google du bouton de connexion vient de
[Devicon v2.17.0](https://github.com/devicons/devicon/blob/54cfe13ac10eaa1ef817a343ab0a9437eb3c2e08/icons/google/google-original.svg),
sous [MIT](licenses/devicon-MIT.txt).
Le pictogramme Google Play vient de
[Simple Icons v14.0.0](https://github.com/simple-icons/simple-icons/blob/6dcfdc2f58f6150d7b097b5cab158d27413f6366/icons/googleplay.svg),
sous [CC0-1.0](licenses/simple-icons-CC0.txt), avec les couleurs adaptées pour le site.
Les marques restent celles de leurs propriétaires.

Les drapeaux sont issus de flag-icons, © Panayiotis Lipiridis, avec leur licence
MIT dans `www/public/flags/LICENSE`. Les [logos de plateformes](www/public/logos/README.md)
viennent de Devicon (MIT) et Simple Icons (CC0), avec leurs textes joints.
Les marques restent celles de leurs propriétaires.
