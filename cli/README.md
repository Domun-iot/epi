# éPI

éPI collects Bluetooth Low Energy (BLE) weigh-ins from nearby devices. It decodes Xiaomi advertisements and those of several manufacturers. For standard scales, it receives the Weight Measurement characteristic (2A9D) of the GATT Weight Scale service (181D). See the [scales and protocols catalogue](../docs/BALANCES-BLE.md).

## Getting started

On Windows 10 or 11 x64, run `release/cli/windows/epi-cli.exe`. You can copy this file alone. It embeds Node.js and the Bluetooth scanner, which uses the .NET Framework and WinRT components supplied by Windows.

On Linux, run `./release/cli/linux/epi-cli --help`. The binary embeds Node.js. CLI Bluetooth scanning remains Windows-only.

The CLI follows the same [data discovery order](../README.md#data) as the desktop interface.

In the repository, run `run/cli.bat` from the root. On first launch, it prepares Node.js, checks Windows-supplied .NET Framework and WinRT components and compiles the Bluetooth reader. The release is in `release/cli/windows/`.

Use `run/prep/cli.bat` to check or install prerequisites separately, `run/build/cli.bat` to rebuild the release and `run/dev/cli.bat` to run sources. The development launcher compiles the Windows reader in a temporary directory when scanning starts. Release builds use npm to install build tools.

On Linux, `sh run/prep/cli.sh` prepares Node.js, `sh run/build/cli.sh` builds `release/cli/linux/epi-cli` and `sh run/cli.sh --help` runs the release. `sh run/dev/cli.sh --help` runs sources. CLI Bluetooth scanning uses the Windows API.

Wait for “Écoute Bluetooth active” (Bluetooth listening active), then step onto the scale near the PC. Stay barefoot on the electrodes until measurement ends to receive impedance. Quit with Ctrl+C.

The program automatically saves one record per run in `data/measures/<profile>/YYYY-MM-DD-HH-MM-SS.json`, including in `--raw` mode. Filenames use UTC. Records received in the same second receive a suffix (`-2`, `-3`, etc.). Each file contains `receivedAt` (PC reception time in UTC), `profile`, `device` (a copy of the scale record), `measures` (weight, unit and impedance), `calculations` and finally `reception`. This section starts with `raw.hex` (Xiaomi payload bytes in original order), followed by `bluetooth` (`serviceUuid`, `service` name, source address and `rssiDbm` signal strength) and `scale` (stabilised weight `stable`, load removed `removed` and scale clock `scaleTime`). Data unavailable in older records is `null`. An unnamed temporary profile uses `_sans-profil`. A first record with impedance is saved immediately. A Weight Scale record is saved on receipt. For Xiaomi, a record without impedance waits up to fifteen seconds before writing. If a record with impedance arrives within that period with the same address, scale timestamp, weight and unit, only the complete record is saved. Advertisements following load removal are discarded; identical measurements for the same address and scale timestamp are grouped within a sliding 30-second window. At timeout, weight alone is saved if necessary. The program exits once the weigh-in is saved.

- `weight` and `unit`: weight and transmitted unit (`kg` or `lb`).
- `impedanceOhms`: impedance in ohms, or `null` if unavailable. Fat and muscle percentages are not in these advertisements.
- `receivedAt`: PC reception date in UTC. `scaleTime` is the onboard clock, without a time zone; it may be inaccurate.
- `address` and `rssi`: Bluetooth address and signal strength in dBm.

```powershell
node index.cjs --seconds 30
node index.cjs --mac AA:BB:CC:DD:EE:FF
node index.cjs --raw --seconds 30
node index.cjs > console-output.txt
npm test
```

`--raw` shows frames from recognised scale ports, including measurements in progress and duplicates. If nothing appears, check Bluetooth is enabled, move the scale closer and start another measurement. If the phone application connects to the scale, close it during testing.

## Registering or selecting a scale

```powershell
node index.cjs -d "Bathroom"
node index.cjs Malik --appareil "Bathroom"
```

The first weigh-in with a new name creates a record in `data/devices/`. Use only the new scale during registration. If the name already exists, only advertisements from its Bluetooth address are accepted. Without an option, registered scales are recognised by address. For an unknown scale, the program asks for its name after reception, before asking for the user profile. BLE responses enrich the record by Bluetooth address. The advertised name and manufacturer identifiers are updated when received. The weigh-in retains a copy of the record at write time. The offline `bluetooth-companies.json` table is rebuilt from [Nordic Bluetooth Numbers Database](https://github.com/nordicsemi/bluetooth-numbers-database), under BSD-3-Clause, preserving all 4,075 catalogue entries. [Credits and notices](../THIRD_PARTY.md#manufacturer-and-service-tables) specify the revision and selection. If no known manufacturer identifier is advertised, éPI looks up the MAC prefix holder in an offline copy of the [IEEE MA-L, MA-M, MA-S and IAB registries](https://standards.ieee.org/products-programs/regauth/), downloaded on 15 November 2026. The holder may be the radio module supplier. The Xiaomi model is inferred from `MIBFS` and the Huami identifier. Each distinct stable measurement is reported in the terminal with the scale name or address and impedance if available. `--mac` restricts listening to a known address.

The record contains the address, BLE service, advertised name if present in the frame, and advertisement type. The service and advertised name cannot distinguish two identical scales. If a scale changes address, register it under a new name. RSSI remains reception data for each weigh-in.

## Comparing body composition estimates

```powershell
node index.cjs Camille --sexe F --naissance 15/06/1991 --taille 170
node index.cjs cam
node index.cjs Camille --taille 171
node index.cjs
```

Options accept the following forms.

| Parameter | Options |
| --- | --- |
| User | `-u`, `--user`, `--utilisateur` |
| Sex | `-s`, `--sex`, `--sexe` |
| Age | `-a`, `--age`, `--âge` |
| Date of birth | `-b`, `-n`, `--birthdate`, `--birthday`, `--birth`, `--naissance` |
| Height | `-t`, `--height`, `--taille` |
| Help | `-h`, `--help`, `--aide` |

Profiles are kept in `data/profiles/`. Names can be supplied without an option and abbreviated using a prefix that ignores case and accents. The terminal offers a choice if a name is ambiguous or missing. For an unknown name, enter `0` to create that profile. You can also supply its details as arguments. Dates of birth accept `DD/MM/YYYY` or `YYYY-MM-DD`; a fixed age is also accepted. With a date of birth, age is calculated at each weigh-in in Paris time and saved with the results. If a profile is incomplete, the terminal requests missing values before opening Bluetooth. In non-interactive mode, it lists parameters to add. All three characteristics can also be supplied without a name for one session.

The selected weigh-in table shows one metric per row, with the average of available values followed by method columns. Weight and impedance are reported on receipt. `--raw` displays JSON frames. A profile argument applies throughout the session. Without one, the program compares weight with each profile's latest record and selects the smallest percentage difference among profiles within ±10%. If none matches, it lists profiles and offers “0. Créer un profil” (Create a profile). Enter `0`, then name, sex, date of birth or age, and height. The current weigh-in is saved under that new profile. The saved record becomes its new reference. The local `bluetooth-services.json` catalogue retains 820 identifiers and labels for offline diagnostics. Tables are generated from references and additions described in the [table credits](../THIRD_PARTY.md#manufacturer-and-service-tables). Reproduce them with `python3 scripts/rebuild-bluetooth-catalogs.py` from the repository root.

| Column | Method | Required data |
| --- | --- | --- |
| IMC | Weight divided by height squared (BMI) | Weight, height |
| Mi | Community [Mi Fit](https://github.com/lolouk44/xiaomi_mi_scale/blob/master/src/Xiaomi_Scale_Body_Metrics.py) formulae, with source-code thresholds | Weight, height, age, sex and, depending on the row, impedance |
| Sun* | [Sun et al. (2003)](https://pubmed.ncbi.nlm.nih.gov/12540391/), fat-free mass and total body water | Weight, height, sex, impedance |
| Jan* | [Janssen et al. (2000)](https://pubmed.ncbi.nlm.nih.gov/10926627/), skeletal muscle | Height, age, sex, impedance |
| D60* | [Deurenberg et al. (1990)](https://www.inner-image.com/assets/2015/05/4.-Deurenberg-van-der-Kooij-Evers-Hulshof-1990.pdf), fat-free mass after 60 | Weight, height, sex, impedance |
| Deu | [Deurenberg et al. (1991)](https://pubmed.ncbi.nlm.nih.gov/2043597/), adult body fat formula | BMI, age, sex |
| CUN | [Gómez-Ambrosi et al. (2012)](https://pubmed.ncbi.nlm.nih.gov/22179957/), CUN-BAE | BMI, age, sex |
| Wat | [Watson et al. (1980)](https://doi.org/10.1093/ajcn/33.1.27), total body water | Weight, height, age, sex |
| HW | [Hume and Weyers (1971)](https://pmc.ncbi.nlm.nih.gov/articles/PMC476961/), total body water | Weight, height, sex |
| MSJ | [Mifflin–St Jeor et al. (1990)](https://doi.org/10.1093/ajcn/51.2.241), resting energy expenditure | Weight, height, age, sex |
| HB | [Roza and Shizgal (1984)](https://pubmed.ncbi.nlm.nih.gov/6741850/), revised Harris–Benedict | Weight, height, age, sex |
| Owe | Owen et al., weight-based resting expenditure for [men](https://pubmed.ncbi.nlm.nih.gov/3687821/) and [non-athletic women](https://pubmed.ncbi.nlm.nih.gov/3728346/) | Weight, sex |
| Cun* | [Cunningham (1980)](https://pubmed.ncbi.nlm.nih.gov/7435418/), resting expenditure estimated from Sun fat-free mass | Sun fat-free mass |

These comparisons are intended for adults. In starred columns, Xiaomi foot-to-foot impedance replaces resistance measured with reference devices. This substitution has not been validated for this scale model. Mi Fit muscle mass and Janssen skeletal muscle appear on separate rows because the models estimate different quantities. The Mi Fit visceral score is unitless and depends on weight and profile. Metabolic age and protein are community estimates. Bone values do not provide mineral density. Formulae such as [Kyle et al.](https://www.sciencedirect.com/science/article/pii/S0899900700005530) require reactance, which is absent from the Bluetooth frame.

Decoding is based on [ESPHome code](https://github.com/esphome/esphome/blob/dev/esphome/components/xiaomi_miscale/xiaomi_miscale.cpp) and checked against a [real XMTZC05HM capture](https://github.com/lolouk44/hassio-addons/issues/14).
