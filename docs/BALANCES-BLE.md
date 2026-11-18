# BLE scales

Inventory of bathroom scale protocols identified as of 16 November 2026, based on public catalogues and implementations. A commercial name may cover several boards or firmware versions. BLE advertising does not guarantee that a scale broadcasts weigh-ins. [openScale][os] · [BLE Scale Sync][bss] · [Theengs][theengs] · [ESPHome][esp]

- **Integrated** means éPI supports the format. Validation of this extension relies on replayed frames and test vectors.
- **Additional protocols** have published decoders elsewhere or analysable captures. Limitations appear in the tables. The inventory follows cited sources. Variants without captures or public protocols remain to be identified.
- **Impedance** is an electrical measurement. éPI can derive composition estimates using a profile. Some scales directly transmit their own composition results. These two types of data have distinct sources.

## Integrated formats

Byte positions start at 0. LE and BE indicate byte order. For manufacturer advertisements, the scanner supplies the 16-bit identifier separately. Positions are relative to the payload after that identifier unless otherwise stated.

| Port and models | Frame and decoded data | Primary source |
| --- | --- | --- |
| [Xiaomi composition](../shared/scales/xiaomi.js) · Mi Body Composition Scale XMTZC02HM (`MIBCS`) and XMTZC05HM (`MIBFS`) | Advertised service data `181B`, 13 bytes. Unit at 0, status at 1 (impedance `0x02`, stable `0x20`, removed `0x80`). Local date/time at 2–8, impedance at 9–10 in Ω, LE weight at 11–12, ÷200 for kg or ÷100 for lb. Composition calculated from weight, impedance and profile. | [Xiaomi captures and decoding][xiaomi-capture] · [ESPHome decoder][esp-code] · [Theengs][theengs] |
| [Xiaomi weight](../shared/scales/xiaomi-weight.js) · Mi Smart Scale XMTZC01HM (`MI_SCALE`) and XMTZC04HM (`MI SCALE2`) | Advertised service data `181D`, 10 bytes. Unit and status at 0, LE weight at 1–2, local date/time at 3–9. Bit `0x20` indicates stable weight and `0x80` load removal. Weight ÷200 for kg, ÷100 for lb. Mainland Chinese jin is converted to kg. Weight only. | [Xiaomi BLE decoder][xiaomi-ble] · [Advertisement capture][xiaomi-v1] · [Theengs][theengs] |
| [Bluetooth SIG Weight Scale](../shared/scales/weight-scale.js) · bathroom scales indicating the standard characteristic | GATT `181D/2A9D`. Flags at 0, LE weight at 1–2, increments of 0.005 kg or 0.01 lb. Bits 1, 2 and 3 indicate optional local timestamp (7 bytes), user index (1 byte), then BMI (LE, 0.1 increments) and height (LE, 1 mm or 0.1 inch increments). Xiaomi `181D` advertisements and GATT `2A9D` indications have distinct formats. | [Bluetooth SIG · Weight Scale Service][wss] · [GATT Specification Supplement][gss] |
| [Qingniu/QN AABB](../shared/scales/qn-broadcast.js) · FITINDEX FT-26R/FT-26R-W, some RENPHO ES-CS20M / Elis 1, ES-24M-B and ES-26M-W | Manufacturer `FFFF`, prefix `AA BB`, ≥19 bytes. LE weight at 17–18, ÷100 kg. Stability bit 5 at 15. FT-26R devices with signature `51 0E 03` at 19 also accept bit 0. ES-24M-B weight is documented with the same format; its stability flag still needs checking on this revision. | [openScale · QN AABB][os-qn-adv] · [ES-24M-B capture][es24] · [ES-26M-W capture][es26] |
| [Yunmai X](../shared/scales/yunmai-x.js) · YMBS-M268 and Mini 2S M1827CH (M1501) | 14 manufacturer bytes. LE ID and 0–3 reconstruct the reversed MAC. Signature at 4–6, `0B 74 17` or `06 52 11`. XOR checksum of 7–12 at 13. Status `03` at 8 for final result. BE weight at 9–10 in hundredths of kg, BE impedance at 11–12 in Ω. | [openScale · Yunmai X][os-yunmai-x] |
| [PICOOC Mini Lite](../shared/scales/picooc-mini-lite.js) · `PICOOC-L` | 14 manufacturer bytes. ID and bytes 0–3 form the MAC in display order. 8-bit sum equals `FF`, including ID and checksum. Result status `39` at 4, BE weight at 6–7 ÷20 kg, BE impedance at 8–9 ÷10 Ω. `FFFF` indicates missing impedance. | [openScale · PICOOC Mini Lite][os-picooc] |
| [Etekcity Fit 8S](../shared/scales/etekcity-fit-8s.js) | Manufacturer `06D0`, 20 bytes. Header `01`, reversed MAC at 1–6, signature `C0 A8` or `C0 A9` at 7–8. Three-byte LE weight at 10–12 in grams, LE impedance at 13–14 in Ω where available, stable status `01` at 15. | [Fit 8S decoder][etekcity-fit8s] · [openScale · Fit 8S][os-fit8s] · [Fit 8S captures][fit8s-capture] |
| [Scale Up](../shared/scales/scale-up.js) · advertised name `da` | 9 manufacturer bytes. ID contains status `D0` or `E0` (stable) and the high weight byte. Low byte at 0, 0.01 kg increments. MAC at 3–8. Unit of electrical reading at 1–2 remains unknown. | [openScale · Scale Up][os-scaleup] |
| [Fitdays/ICOMON AAA](../shared/scales/silvergear.js) · Silvergear Smart Scale 108, INSMART `AAA006`, Foryond FG263LB `AAA002`, beatXP SMARTPLUS BXPBMI1004 `AAA041`, `AAA007`, `AAA013` and `AAA07A` (Posture FG220LB) | 12 manufacturer bytes, reversed MAC at 0–5. For `A0AC`, type `0D` at 10 and modulo-32 sum of 6–10 checked at 11. On identified AAA variants, the ID's high byte XOR-masks the final six bytes, containing decoded type `AD` and checksum. After unmasking: stability bit 7 at 6, weight in grams in the lower 18 bits of BE bytes 7–9. | [Silvergear captures][silvergear] · [beatXP protocol][beatxp] · [openScale · AAA][os-aaa] |
| [Senssun IF_B7](../shared/scales/senssun-if-b7.js) · Grifema GA2001 | Manufacturer `0100`, 17 bytes. Header `02 03 11`, MAC at 3–8, BE weight at 10–11 in hundredths of kg. Final status `A1` or `A2` at 14, sum of bytes 9–15 at 16. Weight uses kg for both kg and lb displays. | [IF_B7 captures][senssun] |
| [OKOK / Chipsea advertisements](../shared/scales/okok.js) · C0 (`Yoda0`, `Yoda1` or unnamed), Fitelo FIT PRO 2025-1 (`tzc`), V11, V20 (`ADV`), VF0 | C0: 13 bytes, BE weight at 0–1, status and scale factor at 6, MAC echo or Yoda signature. V20: ID `20CA`, 19 bytes, BE weight at 8–9, status at 6 and XOR checksum at 12. V11: ID `11CA`, 23 bytes, weight at 3–4, unit and scale factor at 9, XOR at 16. VF0: ID `F0FF`, LE weight at 2–3, reading visible in diagnostics. Saving VF0 still requires a documented stability flag. The port records weight. On Fitelo, the BE field at 2–3 indicates electrode contact. The scale address may change on restart. | [openScale · OKOK][os-okok] · [OKOK captures][ble-okok] · [Fitelo capture][fitelo] |
| [Eufy](../shared/scales/eufy.js) · C1 T9146/P1 T9147, P2 T9148/P2 Pro T9149, C20 T9130/P3 T9150 | Three manufacturer advertisement layouts. C1/P1: 18 bytes, `CF` at 4, LE weight at 7–8, status at 13, XOR at 14. P2/P2 Pro: 19 bytes, `CF` at 6, LE weight at 9–10, status at 15. P2 Pro heart rate at 7 when flagged by 8. C20/P3: at least 18 bytes, LE weight at 12–13, status at 10 (e.g. `01` live, `05` locked). When the model is identified, flags allow heart rate at 15 and LE impedance at 17–18 ÷10 Ω. Weight in hundredths of kg in all three layouts. | [Eufy client][eufy-code] · [C20/P3 captures][eufy-capture] · [C20][eufy-c20] · [P3][eufy-p3] |
| [AiLink/eLink EL1](../shared/scales/ailink.js) · AiLink Body Fat EL1 (CID/VID/PID `01/03/01`) | Manufacturer `0301`, 18 bytes. PID at 0, reversed MAC at 1–6, sum of 8–17 at 7. TEA block at 8–15. After decryption: status at 1 (`FF` final), unit and decimals at 2, BE weight at 3–4, BE impedance at 5–6. The port accepts kg and uses final-frame impedance if present. | [EL1 protocol verified on reception][os-ailink-lib] · [Synthetic test vectors][os-ailink-test] |

On Android, the current scanner provides cached snapshots. éPI ignores identical advertisements remaining in that cache. Two consecutive weigh-ins with exactly the same frame and no observable transition may therefore be confused. On macOS, a peripheral identifier may replace the MAC. Ports checking a MAC echo then use their other documented signature where available.

In a weigh-in record, `measures.deviceMetrics` retains additional device fields, including GATT height and BMI, heart rate or contact status depending on format. `calculations` contains éPI-calculated values. Reception retains provenance and frames where available.

## Additional protocols identified

### Advertisements

| Family and models | Data and reading requirements | Primary source |
| --- | --- | --- |
| Xiaomi S400 (MJTZC01YM) | Encrypted MiBeacon. Weight, impedance and heart rate depending on frame. Authenticated decryption and identifier association require an owner-supplied bind key and scale address. | [openScale][os] · [BLE Scale Sync][bss-ha] |
| Xiaomi S800 (ms116), S200 | Encrypted MiBeacon. Cited projects decode weight depending on model. Bind key required. S800 impedance and composition still need capture-based verification. | [XiaomiS800Handler][os-s800] · [BLE Scale Sync][bss-ha] |
| AiLink/eLink · Healthgenie HB-411 (CID `16`) | LingYang encryption variant. Weight and raw electrical measurement. Compatible clients estimate composition. EL1 targets a different variant. | [LocalScale][localscale] |
| Fitdays/ICOMON AAA · beatXP SMARTPLUS BXPBMI1004 | Weight uses the AAA port. A separate type `06` frame carries impedance. Linking it to weight from the same weigh-in remains to be implemented. | [Capture-derived specification][beatxp] |
| Sinocare and IFIT | Weight in manufacturer advertisements. Repetition-based stabilisation in the public decoder requires distinguishing new frames from cached advertisements. | [openScale · Sinocare][os-sinocare] |

### Connections and standard Bluetooth services

| Family and models | Data and reading requirements | Primary source |
| --- | --- | --- |
| Bluetooth SIG Body Composition Service, WSP-compliant device | `181B/2A9C` indicates body fat percentage and optional fields such as impedance, muscle, fat-free and water mass. WSP uses a separate weight indication on `181D/2A9D`. Indications from the same weigh-in must be matched by device and user, and fragmented composition indications reassembled. | [Bluetooth SIG · Body Composition Service][bcs] · [GATT Specification Supplement][gss] |
| A&D UC-352BLE, Samsung Smart Scale GP-BELAD001BP0 | Standard weight. Depending on model, bonded connection or clock setup before reception. Supporting `2A9D` alone does not verify the pairing dialogue. | [openScale · PlainSigScaleHandler][os-sig] · [BLE Scale Sync][bss] |
| RENPHO ES-WBE28 and A-R003 variant | Weight through the standard Weight Scale family. Some firmware requires additional steps; A-R003 is experimental in the source. | [RENPHO guide][bss-renpho] |
| Beurer BF105, BF500, BF600, BF720, BF788, BF950, BF1000 | SIG services plus user management. PIN or GATT consent, bonded connection and model-specific user slot determine results. | [Beurer guide][bss-beurer] · [openScale][os] |
| Beurer BF450 and Beurer BF915 / Sanitas SBF72 / SBF73 | BF450 has its own dialogue. BF915 shares a Sanitas handler in openScale. SBF72/SBF73 notably require a preconfigured user. | [openScale][os] · [Beurer/Sanitas guide][bss-beurer] |
| Omron BCM-500, HBF-222T, HBF-227T, HBF-228T, HBF-230T, HBF-702T, KRD-703T and VIVA | Shared WLC handler in openScale. Pairing and consent commands precede reading. | [openScale][os] |
| Soehnle Shape 50/100/200 and Style 100 | Documented weight and composition results, requiring preconfiguration of the first user. | [openScale][os] · [BLE Scale Sync][bss] |
| Salter Health SA00656 / SA00432 | Weight. The scale stops transmitting quickly after weighing. | [BLE Scale Sync][bss] |

### Other published GATT connections

These families require a GATT session with their characteristics and, where applicable, writes to initialise weighing. **Composition** means the project retrieves or calculates these results. Where the source identifies transmitted fields, the table specifies them.

| Family / models | Data and protocol specifics | Primary source |
| --- | --- | --- |
| Connected Qingniu/QN · RENPHO ES-CS20M, ES-30M, ES-32MD, Elis 1, Kamtron CS20M, FITINDEX, Elektra and Sencor | Weight and impedance across several dialects. Same-name RENPHO variants with AABB advertisements or GATT `1A10` use other branches. | [QN guide][bss-qn] · [QN exchange decoding][qn] |
| Extended QN · Arboleaf 19/20 bytes, CS10E, CS10G, CS10K, GE Fit Plus CS 10 G | Weight, sometimes transmitted impedance and composition results. User profile, dialect and profile key determine fields. | [QN guide][bss-qn] |
| RENPHO ES-CS20M (`1A10` service) | Proprietary protocol on some revisions. Weight and resistance in the result frame. | [RENPHO guide][bss-renpho] |
| RENPHO ES-26BB-B, Elis Solar R-A012/R-A020 | Same handler family, weight and impedance. | [openScale][os] · [RENPHO guide][bss-renpho] |
| RENPHO R-MSC04 MorphoScan Nova | Weight and transmitted fat percentage when the expected profile byte is supplied. | [RENPHO guide][bss-renpho] |
| Classic 1byone, Eufy T9120 A1, T9146 C1 and T9147 P1 | Weight and impedance after weighing depending on model. | [openScale][os] · [Eufy client][eufy] |
| New-version 1byone | Separate handler from classic family. Weight and composition, history according to source. | [openScale][os] |
| Terraillon 1BODY CONNECT and 1X-LINE | Shared BodyConnect handler, weight, composition and history. | [openScale][os] |
| Eufy P2 (T9148) / P2 Pro (T9149) | Impedance and additional GATT events with authenticated dialogue. P2 Pro may report heart rate. | [Eufy client][eufy] · [BLE Scale Sync][bss] |
| Eufy Smart Scale T9140 | Listed by the Eufy client. Protocol revision to reuse in éPI remains to be confirmed. | [Eufy client][eufy] |
| Yunmai Signal / Mini / Mini 2 / SE | Weight. Impedance and sometimes scale-calculated fat percentage on some firmware. SE does not provide impedance in BLE Scale Sync. | [openScale][os] · [BLE Scale Sync][bss] |
| Beurer BF700/BF710/BF800, Runtastic Libra, Sanitas SBF70, SilverCrest SBF75 and Crane | Shared Beurer/Sanitas dialogue. Composition and history depending on model. BF710 may require a profile previously created in the manufacturer's application. | [openScale][os] · [Beurer/Sanitas guide][bss-beurer] |
| Medisana BS430 / BS440 / BS444 | Shared handler. Weight, composition and stored history depending on revision. | [openScale][os] · [BLE Scale Sync][bss] |
| Huawei AH100 and CH100 | Weight and composition results for the supplied profile. Some revisions depend on the real BLE address. | [openScale][os] · [BLE Scale Sync][bss] |
| Honor CH100S | Specific handler. Weight and composition after dialogue. | [openScale][os] |
| Huawei Scale 2 Pro / 3 / 3 Pro | Hagrid dialogue with existing CAK, C1 and C2 credentials supplied by the owner. | [openScale][os] |
| Wyze WHSCL1 and iHealth HS2S / HS2S Pro | Reused handler. Wyze WHSCL1 requires its device key. openScale marks iHealth models as not hardware-tested. | [openScale][os] |
| Wyze Scale X | Separate handler, weight, composition and history according to openScale. | [openScale][os] |
| PICOOC Latin-S, PICOOC-CC/CQ/S3, Mini Pro and S3 Lite V2.0 | Weight and impedance. The same handler processes 13- or 16-byte frames depending on version. | [openScale][os] |
| QardioBase B100 / QardioBase 2 | Weight and results after profile identification on the scale, including fat, water, muscle and bone. Proprietary GATT dialogue. QardioBase X protocol remains to be confirmed. | [openScale][os] · [LibreBase captures][librebase] |
| Withings Body Smart WBS13 and Body Comp WBS12 | Local GATT: weight, fat, fat-free, muscle, bone and water masses, heart rate and other model-dependent fields. Withings Body WBS06 (Nokia Body) requires Bluetooth Classic to deliver weight. | [Withings Local][withings] |
| Realme Smart Scale RMH2011 | Weight and composition, history reading in the public handler. | [openScale][os] |
| REDMOND SkyBalance RS-73S / RS-744S / RS-745S / RS-762S / RS-773S / RS-78S | Weight transmitted in the shared SkyBalance dialogue. | [openScale][os] |
| ALPHA Smart Scale PRO 3, Meditive UIP-50, Taylor 5331891 BIA and Urikar Aero I | Shared Taylor BIA handler. Weight and composition with electrode contact. | [openScale][os] |
| Active Era BF-06/BS-06 and AC 27 family (Fitdays, Starfit or Femmto) | Weight and impedance after initialisation and profile transmission. AC 27 references and variants must be confirmed before applying the same dialogue. | [openScale][os] · [BLE Scale Sync][bss] |
| Fitdays FG2202WB, Hoffen HO-36, Lescale F4P, Runstar R6, Sacoma Ultra | Shared R6 handler in openScale. Impedance depends on handle contact on eight-electrode models. | [openScale][os] |
| Runstar R5 | Separate handler. Weight and profile commands. Composition fields remain partly interpreted. | [openScale][os] |
| SWAN / Icomon (MGB, YG), Hutbit 218008/WL292 | Weight and composition in published implementations. Hutbit is also sold as SWAN. Check dialect before merging ports. | [openScale][os] · [BLE Scale Sync][bss] |
| Robi S9 and Healthkeep S11 / Speediance FG2211WBF | Weight on Robi and S11. The Speediance branch of the same Lefu/Icomon group adds composition data. | [openScale][os] · [BLE Scale Sync][bss] |
| HealthKeep 280 | Separate handler. Weight and composition according to openScale. | [openScale][os] |
| Hoffen BBS-8107 / ProfiCare PC-PW 3008 BT | Same Chipsea “WeChat” firmware, weight and composition in the shared handler. | [openScale][os] · [BLE Scale Sync][bss] |
| Chipsea-BLE / OKOK International (GATT `FFF0`) | Connected weight and composition. Connectionless OKOK broadcast models use another protocol. | [openScale][os] |
| Senssun Fat model A | Proprietary GATT `FFF0`. Weight and composition. Model B needs separate investigation. IF_B7 advertisements belong to another family. | [openScale][os] · [BLE Scale Sync][bss] |
| Excelvan CF36xBLE (CF366/CF369) | Weight and composition. Shared handler also provides unit configuration. | [openScale][os] · [BLE Scale Sync][bss] |
| Digoo DG-SO38H (Mengii) | Weight and composition. Prior initialisation through the original application according to openScale. | [openScale][os] |
| Etekcity ESF-551 (including Japanese variant), ESF-17/18/24, EFS-A591S Apex HR, EFS-C651 | Connected weight and impedance. ESF-17/18/24 share a protocol in the public client. Apex HR adds heart rate. Models other than ESF-551 are experimental in the client. | [Etekcity client][etekcity] · [openScale][os] |
| Trisa Body Analyze 4.0 and ADE BA 1600 (fitvigo) | Weight and protocol resistance whose scale has not been established as ohms. | [Trisa protocol][os-trisa] · [BLE Scale Sync][bss] |
| Inlife (FatScale) | Weight and composition in published GATT dialogue. | [openScale][os] · [BLE Scale Sync][bss] |
| Hesley (YunChen) | Weight and composition in published dialogue. | [openScale][os] · [BLE Scale Sync][bss] |
| Exingtech Y1 (VScale) | Weight, composition and profiles according to openScale. | [openScale][os] · [BLE Scale Sync][bss] |
| Koogeek S1 | Weight and composition according to BLE Scale Sync, with unstable GATT discovery in published tests. | [BLE Scale Sync][bss] |
| AFU-BH-TZ-B1, Belter/Ebelter Body Fat-B2 (EF-916B4), Dr. Trust SSW532 | Three separate handlers. Weight and composition according to public catalogue. | [openScale][os] |
| EEBBL Body Fat P1 (8 electrodes), Body Pod 2 | Two separate handlers. Weight, with partly interpreted composition in the catalogue. | [openScale][os] |
| Cult Smart Scale Pro | GATT `FFF0`, usable weight and impedance. Proprietary composition frame remains partly interpreted. | [openScale][os] · [Cult captures][cult] |
| FitTrack Dara 2.0, Hume Health Dara 2.0 | Separate openScale handlers despite similar names. Weight and composition depending on variant. | [openScale][os] |
| Keep S3, Relaxmedic, RyFit (云悦), Vitafit VT701, Weight Gurus 0376 | Separate openScale handlers. Weight and composition, history only on some models. | [openScale][os] |
| Custom openScale | DIY bathroom scale profile, weight and measurements supplied by the peripheral implementation. | [openScale · Custom Bluetooth Scale][os-custom] |
| Connected Xiaomi Mi Scale v1/v2 | History reading depending on model, in addition to weight already read through these generations' advertisements. | [openScale][os] |
| e.volve Fitdays (EAN 8720828067765) | GATT dialogue with profile and result frames. Weight and dual-frequency segmental impedance. | [Fitman capture-derived documentation][fitman] |
| Activ8rlives Body Analyser | Profile acceptance, weight and composition fields at documented confidence levels. | [Activ8rlives protocol][activ] |
| Mondeer and `CC08` service OEMs | Proprietary GATT exchanges with fragment reassembly. Weight and composition in records. Other brands need captures. | [Mondeer Bluetooth Scale][mondeer] |
| Tanita BC-401 | Public captures of dialogue, weight and displayed composition. Identification of all on-wire fields remains to be confirmed. | [Open Tanita captures][tanita] |

The openScale catalogue also contains historical entries such as Beurer BF850, SilverCrest SBF77, Easy Home 64050, Accuway, Vigorun and Quanta QTBL10. Firmware references, transport and format still need cross-checking against current handlers or captures before assigning a port. [Historical openScale catalogue][os]

éPI covers bathroom scales. Bluetooth Classic (e.g. iHealth HS3), Wi-Fi as the sole weighing channel and kitchen scales (e.g. Atomax Skale I/II) involve other uses or transports. [openScale][os] · [Theengs · Atomax][atomax]

## Adding a model

For an existing format, attach the signature or alias to the protocol port in [shared/scales](../shared/scales/). For a new format, add a port and document transport, signature, lengths, byte order, units and status flags. Use a stable frame and incomplete or unrelated frames to check false-positive rejection. A scale may require a capture for each hardware revision.

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
