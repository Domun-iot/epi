# Balances BLE

Inventaire des protocoles de pèse-personnes retrouvés au 16 novembre 2026. Le rapprochement part des catalogues publics et de leurs implémentations. Un nom commercial peut couvrir plusieurs cartes ou firmwares. Une publicité BLE ne garantit pas que la balance y transmet des pesées. [openScale][os] · [BLE Scale Sync][bss] · [Theengs][theengs] · [ESPHome][esp]

- **Intégré** indique que le format est pris en charge par éPI. La validation de cette extension repose sur des trames rejouées et des vecteurs de test.
- Les **protocoles complémentaires** ont une lecture publiée ailleurs ou des captures analysables. Les limites figurent dans le tableau. Le recensement suit les sources citées. Les variantes sans capture ou protocole public restent à identifier.
- Une **impédance** est une mesure électrique. éPI peut en tirer des estimations de composition avec le profil. Certaines balances transmettent directement leurs propres résultats de composition. Les deux types de données ont des sources distinctes.

## Formats intégrés

Les positions d'octets partent de 0. LE et BE indiquent l'ordre des octets. Dans une annonce de type fabricant, le scanner fournit l'identifiant sur 16 bits à part. Les positions sont relatives à la charge utile après cet identifiant, sauf mention contraire.

| Port et modèles | Trame et données décodées | Source primaire |
| --- | --- | --- |
| [Xiaomi composition](../shared/scales/xiaomi.js) · Mi Body Composition Scale XMTZC02HM (`MIBCS`) et XMTZC05HM (`MIBFS`) | Données de service annoncées `181B`, 13 octets. Unité à 0, état à 1 (impédance `0x02`, stable `0x20`, retrait `0x80`). Date et heure locales à 2–8, impédance à 9–10 en Ω, poids à 11–12 en LE, ÷200 en kg ou ÷100 en lb. La composition est calculée à partir du poids, de l'impédance et du profil. | [Captures et décodage Xiaomi][xiaomi-capture] · [Décodeur ESPHome][esp-code] · [Theengs][theengs] |
| [Xiaomi poids](../shared/scales/xiaomi-weight.js) · Mi Smart Scale XMTZC01HM (`MI_SCALE`) et XMTZC04HM (`MI SCALE2`) | Données de service annoncées `181D`, 10 octets. Unité et état à 0, poids LE à 1–2, date et heure locales à 3–9. Le bit `0x20` indique le poids stabilisé et `0x80` le retrait. Poids ÷200 en kg, ÷100 en lb. Le jin de Chine continentale est rendu en kg. La trame ne porte qu'une mesure de poids. | [Décodeur Xiaomi BLE][xiaomi-ble] · [Capture de publicité][xiaomi-v1] · [Theengs][theengs] |
| [Weight Scale Bluetooth SIG](../shared/scales/weight-scale.js) · pèse-personnes qui indiquent la caractéristique standard | GATT `181D/2A9D`. Drapeaux à 0, poids LE à 1–2, pas de 0,005 kg ou 0,01 lb. Les bits 1, 2 puis 3 indiquent respectivement la présence de l'horodatage local (7 octets), de l'index utilisateur (1 octet), puis de l'IMC (LE, pas de 0,1) et de la taille (LE, pas de 1 mm ou 0,1 po). L'annonce Xiaomi `181D` et l'indication GATT `2A9D` ont des formats distincts. | [Bluetooth SIG · Weight Scale Service][wss] · [GATT Specification Supplement][gss] |
| [Qingniu/QN AABB](../shared/scales/qn-broadcast.js) · FITINDEX FT-26R/FT-26R-W, certaines RENPHO ES-CS20M / Elis 1, ES-24M-B et ES-26M-W | Fabricant `FFFF`, préfixe `AA BB`, ≥19 octets. Poids LE à 17–18, ÷100 kg. Stabilité bit 5 à 15. Les FT-26R portant la signature `51 0E 03` à 19 acceptent aussi le bit 0. Le poids ES-24M-B est documenté avec le même format. Son indicateur de stabilité reste à vérifier sur cette révision. | [openScale · QN AABB][os-qn-adv] · [Capture ES-24M-B][es24] · [Capture ES-26M-W][es26] |
| [Yunmai X](../shared/scales/yunmai-x.js) · YMBS-M268 et Mini 2S M1827CH (M1501) | 14 octets fabricant. ID LE et 0–3 reconstituent la MAC inversée. Signature à 4–6, `0B 74 17` ou `06 52 11`. Somme XOR de 7–12 à 13. État `03` à 8 pour le résultat final. Poids BE à 9–10 en centièmes de kg, impédance BE à 11–12 en Ω. | [openScale · Yunmai X][os-yunmai-x] |
| [PICOOC Mini Lite](../shared/scales/picooc-mini-lite.js) · `PICOOC-L` | 14 octets fabricant. L'ID et les octets 0–3 constituent la MAC dans l'ordre d'affichage. Somme sur 8 bits égale à `FF`, ID et checksum compris. État `39` à 4 pour le résultat, poids BE à 6–7 ÷20 kg, impédance BE à 8–9 ÷10 Ω. `FFFF` indique une impédance absente. | [openScale · PICOOC Mini Lite][os-picooc] |
| [Etekcity Fit 8S](../shared/scales/etekcity-fit-8s.js) | Fabricant `06D0`, 20 octets. En-tête `01`, MAC inversée à 1–6, signature `C0 A8` ou `C0 A9` à 7–8. Poids LE sur 3 octets à 10–12 en grammes, impédance LE à 13–14 en Ω lorsqu'elle est disponible, état stable `01` à 15. | [Décodeur Fit 8S][etekcity-fit8s] · [openScale · Fit 8S][os-fit8s] · [Captures Fit 8S][fit8s-capture] |
| [Scale Up](../shared/scales/scale-up.js) · nom annoncé `da` | 9 octets fabricant. L'ID contient l'état `D0` ou `E0` (stable) et l'octet haut du poids. L'octet bas est à 0, pas de 0,01 kg. MAC à 3–8. L'unité de la lecture électrique à 1–2 reste inconnue. | [openScale · Scale Up][os-scaleup] |
| [Fitdays/ICOMON AAA](../shared/scales/silvergear.js) · Silvergear Smart Scale 108, INSMART `AAA006`, Foryond FG263LB `AAA002`, beatXP SMARTPLUS BXPBMI1004 `AAA041`, `AAA007`, `AAA013` et `AAA07A` (Posture FG220LB) | 12 octets fabricant, MAC inversée à 0–5. En `A0AC`, type `0D` à 10 et somme modulo 32 de 6–10 vérifiée à 11. Sur les variantes AAA identifiées, l'octet haut de l'ID masque par XOR les six derniers octets, qui contiennent le type `AD` et la somme de contrôle après décodage. Une fois le masque retiré, bit 7 à 6 pour la stabilité, poids en grammes dans les 18 bits bas de 7–9 en BE. | [Captures Silvergear][silvergear] · [Protocole beatXP][beatxp] · [openScale · AAA][os-aaa] |
| [Senssun IF_B7](../shared/scales/senssun-if-b7.js) · Grifema GA2001 | Fabricant `0100`, 17 octets. En-tête `02 03 11`, MAC à 3–8, poids BE à 10–11 en centièmes de kg. État final `A1` ou `A2` à 14, somme des octets 9–15 à 16. Le poids est en kg pour les affichages kg et lb. | [Captures IF_B7][senssun] |
| [OKOK / Chipsea annonces](../shared/scales/okok.js) · C0 (`Yoda0`, `Yoda1` ou sans nom), Fitelo FIT PRO 2025-1 (`tzc`), V11, V20 (`ADV`), VF0 | C0, 13 octets, poids BE à 0–1, état et échelle à 6, écho MAC ou signature Yoda. V20, ID `20CA`, 19 octets, poids BE à 8–9, état à 6 et XOR de contrôle à 12. V11, ID `11CA`, 23 octets, poids à 3–4, unité et échelle à 9, XOR à 16. VF0, ID `F0FF`, poids LE à 2–3, relevé visible dans le diagnostic. Un indicateur de stabilité documenté reste nécessaire pour enregistrer VF0. Le port enregistre le poids. Sur Fitelo, le champ BE à 2–3 renseigne le contact avec les électrodes. L'adresse de la balance peut changer au redémarrage. | [openScale · OKOK][os-okok] · [Captures OKOK][ble-okok] · [Capture Fitelo][fitelo] |
| [Eufy](../shared/scales/eufy.js) · C1 T9146/P1 T9147, P2 T9148/P2 Pro T9149, C20 T9130/P3 T9150 | Annonces fabricant en trois dispositions. C1/P1, 18 octets, `CF` à 4, poids LE à 7–8, état à 13, XOR à 14. P2/P2 Pro, 19 octets, `CF` à 6, poids LE à 9–10, état à 15. Sur P2 Pro, fréquence cardiaque à 7 lorsque 8 la signale. C20/P3, au moins 18 octets, poids LE à 12–13, état à 10 (par exemple `01` en direct, `05` verrouillé). Lorsque le modèle est identifié, les drapeaux permettent de lire la fréquence cardiaque à 15 et l'impédance LE à 17–18 ÷10 Ω. Poids en centièmes de kg pour les trois dispositions. | [Client Eufy][eufy-code] · [Captures C20/P3][eufy-capture] · [C20][eufy-c20] · [P3][eufy-p3] |
| [AiLink/eLink EL1](../shared/scales/ailink.js) · AiLink Body Fat EL1 (CID/VID/PID `01/03/01`) | Fabricant `0301`, 18 octets. PID à 0, MAC inversée à 1–6, somme de 8–17 à 7. Bloc TEA à 8–15. Une fois déchiffré, état à 1 (`FF` final), unité et décimales à 2, poids BE à 3–4, impédance BE à 5–6. Le port accepte le kg et utilise l'impédance de la trame finale si elle est présente. | [Protocole EL1 vérifié en réception][os-ailink-lib] · [Vecteurs de test synthétiques][os-ailink-test] |


Sur Android, le scanner actuel fournit des instantanés mis en cache. éPI ignore les annonces identiques qui restent présentes dans ce cache. Deux pesées consécutives dont la balance rediffuse exactement la même trame sans transition observable peuvent donc être confondues. Sur macOS, un identifiant de périphérique peut remplacer la MAC. Les ports qui vérifient un écho de MAC utilisent alors leur autre signature documentée lorsqu’elle existe.

Dans une fiche de pesée, `measures.deviceMetrics` conserve les champs supplémentaires de l'appareil, dont la taille et l'IMC GATT, la fréquence cardiaque ou l'état du contact selon le format. `calculations` contient les valeurs calculées par éPI. La réception garde la provenance et la trame lorsque celles-ci sont disponibles.

## Protocoles complémentaires repérés

### Annonces

| Famille et modèles | Données et condition de lecture | Source primaire |
| --- | --- | --- |
| Xiaomi S400 (MJTZC01YM) | MiBeacon chiffré. Poids, impédance et fréquence cardiaque selon la trame. Le déchiffrement authentifié et l'association des identifiants nécessitent une clé de liaison fournie par le propriétaire et l'adresse de la balance. | [openScale][os] · [BLE Scale Sync][bss-ha] |
| Xiaomi S800 (ms116), S200 | MiBeacon chiffré. Poids décodé par les projets cités selon le modèle. Clé de liaison requise. L'impédance et la composition S800 restent à qualifier sur capture. | [XiaomiS800Handler][os-s800] · [BLE Scale Sync][bss-ha] |
| AiLink/eLink · Healthgenie HB-411 (CID `16`) | Variante de chiffrement LingYang. Poids et mesure électrique brute. La composition est estimée par le client compatible. Le port EL1 vise une autre variante. | [LocalScale][localscale] |
| Fitdays/ICOMON AAA · beatXP SMARTPLUS BXPBMI1004 | Le poids passe par le port AAA. Une trame séparée de type `06` porte l'impédance. Relier cette trame au poids de la même pesée reste à faire. | [Spécification issue des captures][beatxp] |
| Sinocare et IFIT | Poids dans les annonces fabricant. La stabilisation par répétition utilisée par le décodeur public demande de distinguer les nouvelles trames des annonces en cache. | [openScale · Sinocare][os-sinocare] |

### Connexion et services Bluetooth standard

| Famille et modèles | Données et condition de lecture | Source primaire |
| --- | --- | --- |
| Bluetooth SIG Body Composition Service, appareil conforme au profil WSP | `181B/2A9C` indique le taux de graisse et des champs facultatifs tels que l'impédance, les masses musculaire, maigre et hydrique. Le profil WSP utilise une indication de poids séparée sur `181D/2A9D`. Il faut associer les indications de la même pesée par appareil et utilisateur et réassembler les indications de composition fragmentées. | [Bluetooth SIG · Body Composition Service][bcs] · [GATT Specification Supplement][gss] |
| A&D UC-352BLE, Samsung Smart Scale GP-BELAD001BP0 | Poids standard. Selon le modèle, liaison appairée ou réglage de l'heure avant la réception. La prise en charge de `2A9D` ne vérifie pas à elle seule le dialogue d'appairage. | [openScale · PlainSigScaleHandler][os-sig] · [BLE Scale Sync][bss] |
| RENPHO ES-WBE28 et variante A-R003 | Poids via la famille Weight Scale standard. Certains firmwares requièrent des étapes supplémentaires, et A-R003 est expérimental dans la source. | [Guide RENPHO][bss-renpho] |
| Beurer BF105, BF500, BF600, BF720, BF788, BF950, BF1000 | Services SIG plus gestion des utilisateurs. Le PIN ou consentement GATT, le lien appairé et le créneau selon le modèle conditionnent le résultat. | [Guide Beurer][bss-beurer] · [openScale][os] |
| Beurer BF450 et Beurer BF915 / Sanitas SBF72 / SBF73 | BF450 possède son propre dialogue. BF915 partage un gestionnaire Sanitas dans openScale. Les SBF72/SBF73 demandent notamment un utilisateur préconfiguré. | [openScale][os] · [Guide Beurer/Sanitas][bss-beurer] |
| Omron BCM-500, HBF-222T, HBF-227T, HBF-228T, HBF-230T, HBF-702T, KRD-703T et VIVA | Un gestionnaire WLC commun dans openScale. L'association et les commandes de consentement précèdent la lecture. | [openScale][os] |
| Soehnle Shape 50/100/200 et Style 100 | Poids et résultats de composition documentés, conditionnés par la préconfiguration du premier utilisateur. | [openScale][os] · [BLE Scale Sync][bss] |
| Salter Health SA00656 / SA00432 | Poids. La balance cesse d'émettre rapidement après la pesée. | [BLE Scale Sync][bss] |

### Autres connexions GATT publiées

Les familles ci-dessous demandent une session GATT avec leurs caractéristiques et, selon le cas, des écritures pour initialiser la pesée. La notation **composition** indique que le projet récupère ou calcule ces résultats. Quand la source identifie les champs transmis, le tableau les précise.

| Famille / modèles | Données et particularité du protocole | Source primaire |
| --- | --- | --- |
| Qingniu/QN connecté · RENPHO ES-CS20M, ES-30M, ES-32MD, Elis 1, Kamtron CS20M, FITINDEX, Elektra et Sencor | Poids et impédance sur plusieurs dialectes. Les variantes RENPHO de même nom avec annonce AABB ou service GATT `1A10` suivent d'autres branches. | [Guide QN][bss-qn] · [Décodage des échanges QN][qn] |
| QN étendu · Arboleaf 19/20 octets, CS10E, CS10G, CS10K, GE Fit Plus CS 10 G | Poids, parfois impédance et résultats de composition transmis. Le profil utilisateur, le dialecte et la clé de profil conditionnent les champs. | [Guide QN][bss-qn] |
| RENPHO ES-CS20M (service `1A10`) | Protocole propriétaire de certaines révisions. Poids et résistance dans la trame de résultat. | [Guide RENPHO][bss-renpho] |
| RENPHO ES-26BB-B, Elis Solar R-A012/R-A020 | Même famille de gestionnaires, poids et impédance. | [openScale][os] · [Guide RENPHO][bss-renpho] |
| RENPHO R-MSC04 MorphoScan Nova | Poids, taux de graisse transmis lorsque l'octet de profil attendu est fourni. | [Guide RENPHO][bss-renpho] |
| 1byone classique, Eufy T9120 A1, T9146 C1 et T9147 P1 | Poids et impédance à l'issue de la pesée selon modèle. | [openScale][os] · [Client Eufy][eufy] |
| 1byone nouvelle version | Gestionnaire distinct de la famille classique. Poids et composition, historique selon la source. | [openScale][os] |
| Terraillon 1BODY CONNECT et 1X-LINE | Gestionnaire BodyConnect commun, poids et composition, historique. | [openScale][os] |
| Eufy P2 (T9148) / P2 Pro (T9149) | Impédance et événements supplémentaires sur GATT, avec dialogue authentifié. Le P2 Pro peut rapporter la fréquence cardiaque. | [Client Eufy][eufy] · [BLE Scale Sync][bss] |
| Eufy Smart Scale T9140 | Le client Eufy répertorie ce numéro. La révision de protocole à réutiliser reste à confirmer dans éPI. | [Client Eufy][eufy] |
| Yunmai Signal / Mini / Mini 2 / SE | Poids. Impédance et parfois taux de graisse calculé par la balance sur certains firmwares. La SE ne fournit pas l'impédance dans BLE Scale Sync. | [openScale][os] · [BLE Scale Sync][bss] |
| Beurer BF700/BF710/BF800, Runtastic Libra, Sanitas SBF70, SilverCrest SBF75 et Crane | Dialogue Beurer/Sanitas commun. Composition et historique selon modèle. BF710 peut demander un profil créé auparavant dans l'application constructeur. | [openScale][os] · [Guide Beurer/Sanitas][bss-beurer] |
| Medisana BS430 / BS440 / BS444 | Gestionnaire commun. Poids, composition et historique stocké selon révision. | [openScale][os] · [BLE Scale Sync][bss] |
| Huawei AH100 et CH100 | Poids et résultats de composition pour le profil transmis. Le dialogue de certaines révisions dépend de l'adresse BLE réelle. | [openScale][os] · [BLE Scale Sync][bss] |
| Honor CH100S | Gestionnaire spécifique. Poids et composition après dialogue. | [openScale][os] |
| Huawei Scale 2 Pro / 3 / 3 Pro | Dialogue Hagrid avec identifiants préexistants CAK, C1 et C2, à fournir par le propriétaire. | [openScale][os] |
| Wyze WHSCL1 et iHealth HS2S / HS2S Pro | Gestionnaire réutilisé. La Wyze WHSCL1 exige sa clé d'appareil. Les iHealth sont indiquées comme non testées matériellement par openScale. | [openScale][os] |
| Wyze Scale X | Gestionnaire distinct, poids et composition, historique selon openScale. | [openScale][os] |
| PICOOC Latin-S, PICOOC-CC/CQ/S3, Mini Pro et S3 Lite V2.0 | Poids et impédance. Le même gestionnaire traite des trames de 13 ou 16 octets selon version. | [openScale][os] |
| QardioBase B100 / QardioBase 2 | Poids et résultats envoyés après identification du profil sur la balance, dont graisse, eau, muscle et os. Dialogue en GATT propriétaire. Le modèle QardioBase X constitue un protocole à confirmer. | [openScale][os] · [Captures LibreBase][librebase] |
| Withings Body Smart WBS13 et Body Comp WBS12 | GATT local, poids, masses grasse, maigre, musculaire, osseuse et hydrique, fréquence cardiaque et autres champs selon modèle. La Withings Body WBS06 (Nokia Body) exige une connexion Bluetooth Classic pour délivrer le poids. | [Withings Local][withings] |
| Realme Smart Scale RMH2011 | Poids et composition, lecture de l'historique dans le gestionnaire public. | [openScale][os] |
| REDMOND SkyBalance RS-73S / RS-744S / RS-745S / RS-762S / RS-773S / RS-78S | Poids transmis dans le dialogue SkyBalance commun. | [openScale][os] |
| ALPHA Smart Scale PRO 3, Meditive UIP-50, Taylor 5331891 BIA et Urikar Aero I | Gestionnaire Taylor BIA commun. Poids et composition avec contact sur les électrodes. | [openScale][os] |
| Active Era BF-06/BS-06 et famille AC 27 (Fitdays, Starfit ou Femmto) | Poids et impédance après initialisation et envoi du profil. Les références et variantes AC 27 doivent être confirmées avant d'appliquer le même dialogue. | [openScale][os] · [BLE Scale Sync][bss] |
| Fitdays FG2202WB, Hoffen HO-36, Lescale F4P, Runstar R6, Sacoma Ultra | Gestionnaire R6 commun dans openScale. L'impédance dépend du contact avec les poignées sur les modèles à 8 électrodes. | [openScale][os] |
| Runstar R5 | Gestionnaire distinct. Poids et commandes de profil. Les champs de composition restent partiellement interprétés. | [openScale][os] |
| SWAN / Icomon (MGB, YG), Hutbit 218008/WL292 | Poids et composition dans les implémentations publiées. Hutbit est aussi vendu sous marque SWAN. Vérifier le dialecte avant de fusionner les ports. | [openScale][os] · [BLE Scale Sync][bss] |
| Robi S9 et Healthkeep S11 / Speediance FG2211WBF | Poids sur Robi et S11. La branche Speediance du même ensemble Lefu/Icomon ajoute des données de composition. | [openScale][os] · [BLE Scale Sync][bss] |
| HealthKeep 280 | Gestionnaire distinct. Poids et composition selon openScale. | [openScale][os] |
| Hoffen BBS-8107 / ProfiCare PC-PW 3008 BT | Même firmware Chipsea « WeChat », poids et composition dans le gestionnaire commun. | [openScale][os] · [BLE Scale Sync][bss] |
| Chipsea-BLE / OKOK International (GATT `FFF0`) | Poids et composition avec connexion. Les modèles diffusant en OKOK sans connexion emploient un autre protocole. | [openScale][os] |
| Senssun Fat modèle A | GATT `FFF0` propriétaire. Poids et composition. Le modèle B demande une investigation séparée. L'annonce IF_B7 relève d'une autre famille. | [openScale][os] · [BLE Scale Sync][bss] |
| Excelvan CF36xBLE (CF366/CF369) | Poids et composition. Le gestionnaire commun propose aussi la configuration d'unité. | [openScale][os] · [BLE Scale Sync][bss] |
| Digoo DG-SO38H (Mengii) | Poids et composition. Initialisation préalable via l'application d'origine selon openScale. | [openScale][os] |
| Etekcity ESF-551 (dont variante japonaise), ESF-17/18/24, EFS-A591S Apex HR, EFS-C651 | Poids et impédance en connecté. ESF-17/18/24 ont le même protocole dans le client public. Apex HR ajoute la fréquence cardiaque. Les modèles autres qu'ESF-551 sont expérimentaux dans le client. | [Client Etekcity][etekcity] · [openScale][os] |
| Trisa Body Analyze 4.0 et ADE BA 1600 (fitvigo) | Poids ainsi qu'une résistance dans le protocole, dont l'échelle n'est pas établie comme étant l'ohm. | [Protocole Trisa][os-trisa] · [BLE Scale Sync][bss] |
| Inlife (FatScale) | Poids et composition dans le dialogue GATT publié. | [openScale][os] · [BLE Scale Sync][bss] |
| Hesley (YunChen) | Poids et composition dans le dialogue publié. | [openScale][os] · [BLE Scale Sync][bss] |
| Exingtech Y1 (VScale) | Poids et composition, profils selon openScale. | [openScale][os] · [BLE Scale Sync][bss] |
| Koogeek S1 | Poids et composition d'après BLE Scale Sync, avec découverte GATT instable dans les essais publiés. | [BLE Scale Sync][bss] |
| AFU-BH-TZ-B1, Belter/Ebelter Body Fat-B2 (EF-916B4), Dr. Trust SSW532 | Trois gestionnaires distincts. Poids et composition selon le catalogue public. | [openScale][os] |
| EEBBL Body Fat P1 (8 électrodes), Body Pod 2 | Deux gestionnaires distincts. Poids, avec composition partiellement interprétée dans le catalogue. | [openScale][os] |
| Cult Smart Scale Pro | GATT `FFF0`, poids et impédance exploitables. La trame de composition propriétaire reste partiellement interprétée. | [openScale][os] · [Captures Cult][cult] |
| FitTrack Dara 2.0, Hume Health Dara 2.0 | Gestionnaires distincts dans openScale malgré les noms proches. Poids et composition selon variante. | [openScale][os] |
| Keep S3, Relaxmedic, RyFit (云悦), Vitafit VT701, Weight Gurus 0376 | Gestionnaires distincts dans openScale. Poids et composition, historique seulement selon le modèle. | [openScale][os] |
| Custom openScale | Profil du pèse-personne DIY, poids et mesures fournies par l'implémentation du périphérique. | [openScale · Custom Bluetooth Scale][os-custom] |
| Xiaomi Mi Scale v1/v2 en connecté | Lecture de l'historique selon modèle. Ce dialogue s'ajoute au poids déjà lu via les annonces de ces générations. | [openScale][os] |
| e.volve Fitdays (EAN 8720828067765) | Dialogue GATT avec profil et trames de résultat. Poids et impédance segmentaire à deux fréquences. | [Documentation issue des captures Fitman][fitman] |
| Activ8rlives Body Analyser | Acceptation d'un profil, poids et champs de composition aux niveaux de confiance documentés. | [Protocole Activ8rlives][activ] |
| Mondeer et OEM du service `CC08` | Échanges GATT propriétaires, réassemblage des fragments. Poids et composition dans les enregistrements. Les autres marques demandent une capture. | [Mondeer Bluetooth Scale][mondeer] |
| Tanita BC-401 | Captures publiques du dialogue, du poids et de la composition affichée. L'identification de tous les champs sur le fil reste à confirmer. | [Captures ouvertes Tanita][tanita] |

Le catalogue openScale comporte aussi des entrées historiques telles que Beurer BF850, SilverCrest SBF77, Easy Home 64050, Accuway, Vigorun et Quanta QTBL10. Leur référence de firmware, leur transport et leur format restent à recouper avec les gestionnaires actuels ou une capture avant de leur attribuer un port. [Catalogue historique openScale][os]

Le périmètre d'éPI est le pèse-personne. Bluetooth classique (par exemple iHealth HS3), Wi-Fi comme seul canal de pesée et balances de cuisine (par exemple Atomax Skale I/II) relèvent d'autres usages ou transports. [openScale][os] · [Theengs · Atomax][atomax]

## Ajouter un modèle

Pour un format existant, rattacher la signature ou l'alias au port du protocole dans [shared/scales](../shared/scales/). Pour un nouveau format, ajouter un port et documenter son transport, la signature, les longueurs, l'ordre des octets, les unités et les drapeaux d'état. Utiliser une trame stable et des trames incomplètes ou étrangères pour vérifier le rejet des faux positifs. Une balance peut nécessiter une capture sur chaque révision matérielle.

[es26]: https://github.com/oliexdev/openScale/pull/1522#issuecomment-5768356209
[eufy-c20]: https://github.com/Skriipt/eufy-smart-scale-ble/blob/main/custom_components/eufy_smart_scale_ble/protocols/c20.py
[eufy-capture]: https://github.com/KristianP26/ble-scale-sync/commit/cc50075cc66a97b09f92551fdae19553df25d398
[eufy-p3]: https://github.com/Skriipt/eufy-smart-scale-ble/blob/main/custom_components/eufy_smart_scale_ble/protocols/p3.py
[fit8s-capture]: https://github.com/KristianP26/ble-scale-sync/commit/0c210231551d5dffc98c0fb302b54b96cd371af2
[fitelo]: https://github.com/Mohan9999/fitelo-weighing-scale-debug-app/blob/main/samples/contact-vs-nocontact_2026-05-30.txt
[os-aaa]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/AAAxHandler.kt
[os-ailink-lib]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/libs/AiLinkLib.kt
[os-ailink-test]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/test/java/com/health/openscale/core/bluetooth/libs/AiLinkLibTest.kt
[activ]: https://github.com/mark-a-richardson/activ8rlives-body-analyser-protocol
[atomax]: https://decoder.theengs.io/devices/Skale.html
[bcs]: https://www.bluetooth.com/specifications/specs/body-composition-service-1-0/
[beatxp]: https://github.com/kavinduraisamy/beatxp-smart-scale/blob/main/PROTOCOL.md
[bss]: https://blescalesync.dev/guide/supported-scales
[bss-beurer]: https://blescalesync.dev/guide/scales/beurer
[bss-ha]: https://blescalesync.dev/guide/ha-bluetooth
[bss-qn]: https://blescalesync.dev/guide/scales/qn
[bss-renpho]: https://blescalesync.dev/guide/scales/renpho
[cult]: https://github.com/anshuman852/occult
[es24]: https://github.com/asd333111/bluetooth_scale
[esp]: https://esphome.io/components/sensor/xiaomi_miscale/
[esp-code]: https://github.com/esphome/esphome/blob/dev/esphome/components/xiaomi_miscale/xiaomi_miscale.cpp
[eufy]: https://github.com/bdr99/eufylife-ble-client
[fitman]: https://github.com/DaveNijhuis/Fitman/blob/main/SCALE.md
[gss]: https://btprodspecificationrefs.blob.core.windows.net/gatt-specification-supplement/GATT_Specification_Supplement.pdf
[librebase]: https://github.com/stormychel/LibreBase
[localscale]: https://github.com/anxkhn/localscale
[mondeer]: https://github.com/MicheleMercuri/mondeer-bluetooth-scale-ha
[os]: https://github.com/oliexdev/openScale/wiki/Supported-scales-in-openScale
[os-custom]: https://github.com/oliexdev/openScale/wiki/Custom-Bluetooth-Scale
[os-s800]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/XiaomiS800Handler.kt
[os-scaleup]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/ScaleupHandler.kt
[os-sig]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/PlainSigScaleHandler.kt
[os-sinocare]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/SinocareHandler.kt
[os-trisa]: https://github.com/oliexdev/openScale/wiki/Trisa-Body-Analyze
[qn]: https://github.com/paveldemyanov/qn-scale
[tanita]: https://github.com/oliexdev/openScale/issues/793
[theengs]: https://decoder.theengs.io/devices/devices.html
[withings]: https://github.com/pierosavi/withings-local
[wss]: https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/WSS_v1.0.1/out/en/index-en.html
[ble-okok]: https://github.com/KristianP26/ble-scale-sync/blob/main/src/scales/okok-chipsea.ts
[etekcity]: https://github.com/ronnnnnnnnnnnnn/etekcity_esf551_ble
[etekcity-fit8s]: https://github.com/ronnnnnnnnnnnnn/etekcity_esf551_ble/blob/main/src/etekcity_esf551_ble/fit8s/protocol.py
[eufy-code]: https://github.com/bdr99/eufylife-ble-client/blob/main/eufylife_ble_client/client.py
[os-fit8s]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/EtekcityFit8SHandler.kt
[os-okok]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/OkOkHandler.kt
[os-picooc]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/PicoocBroadcastHandler.kt
[os-qn-adv]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/QNHandlerBroadcast.kt
[os-yunmai-x]: https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/YunmaiXHandler.kt
[senssun]: https://github.com/KristianP26/ble-scale-sync/issues/423
[silvergear]: https://github.com/KristianP26/ble-scale-sync/issues/297
[xiaomi-ble]: https://github.com/Bluetooth-Devices/xiaomi-ble/blob/main/src/xiaomi_ble/parser.py
[xiaomi-v1]: https://gist.github.com/passcod/2132f8d1ca33232108f00e86f6147e47
[xiaomi-capture]: https://github.com/ipanalytics/Xiaomi-Scale-Unlocked-Reverse-Engineering
