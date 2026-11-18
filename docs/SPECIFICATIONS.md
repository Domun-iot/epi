# éPI Tauri 2 specifications

## CLI inventory

| CLI feature | Tauri interface |
| --- | --- |
| Windows scanner, Xiaomi advertisements and GATT indications, status messages | Continuous listening from startup through native Bluetooth |
| Stable weigh-ins only, unloaded frames and duplicates discarded, 15-second wait for Xiaomi impedance, immediate GATT | Same decoding and rules, with multiple weigh-ins per launch |
| `--mac` or named device, `--identify` BLE identification, `--raw` frames, JSON recording | Address filter, device list and Bluetooth log, frame history and details |
| `--seconds`, help and output redirection | Terminal-specific options. The interface stays open and provides data details and ZIP export |
| Record creation by name or after detection, address recognition, BLE enrichment and scale model | Creation and update on received weigh-ins, display-name editing, read-only Bluetooth fields |
| Profile selection by name, case- and accent-insensitive prefix, interactive clarification, profile forced by argument | Profile selector, remembered choice used for display |
| Creating and editing sex used by formulae, date of birth or integer age, height, unnamed session profile | Profile form, record name preserved to retain history links. Manual assignment of unmatched weigh-ins |
| Closest latest weight within ±10%, choice to select or create a profile | Same automatic rule. Selection switches to the identified or confirmed profile |
| Weight in kg/lb, impedance, local/UTC date, provenance and raw frame, record snapshot, comparison of 13 methods | Profile history with fixed date and weight, column selection, methods side by side with icons and colours, access to reception details |
| JSON files for profiles, scales and timestamped measurements, collision suffix | Shared desktop directory and formats, private mobile storage, ZIP merge and backup |

Displayed estimates reuse values already written into each weigh-in. Profile changes apply to future weigh-ins. BMI, Mi, Sun, Janssen, Deurenberg 1990/1991, CUN-BAE, Watson, Hume–Weyers, Mifflin–St Jeor, Harris–Benedict, Owen and Cunningham retain CLI calculations.

## Weigh-in history and details

- In history, headers and cells allow moving a column or column group. Clicking a compatible header toggles grouped and expanded modes. Expanded mode displays the average before individual methods.
- In details, the table displays at full height and the window scrolls vertically. The header remains visible while the table scrolls beneath it. The **Metric** column remains visible during horizontal table scrolling.
- With mouse or touch, headers reorder method columns and detail sections. The **Calculation methods** legend follows column order. Both orders are remembered for the active profile. A click or tap opens the method link or toggles the section.

## Development and verification

1. Isolate the CLI in `cli/`. Move decoding, metadata, profiles and calculations into shared modules. Check the CLI suite and help.
2. Implement acquisition and assignment in a JavaScript domain independent of the interface, with injected storage. Simulate Xiaomi and GATT, stabilisation, saving, identification, new records and storage errors.
3. Connect platform Bluetooth in Tauri, link the interface and CLI JSON through IPC, then test storage and ZIP merging.
4. Test management flows, manual and automatic confirmation, persistence, columns and mobile layout in a browser.
5. Check builds per target and perform physical scale tests last.
