# Translation audit — 17 November 2026

The shared user interface for Tauri (desktop and Android), personal web and hosted web uses 26 language variants. This audit covers its catalogues, screens and incoming application diagnostics.

## Result

| Check | Result after corrections |
| --- | --- |
| Language variants | 26 |
| Keys per catalogue | 461 |
| Total values | 11,986 |
| Missing, extra, duplicate or empty keys | None detected |
| Substitution parameters | Match the English catalogue for every key |
| Literal references in interface and native diagnostics | All present |
| Computed method and indicator keys | All present |
| Identical English copies | Only shared terms and proper names explicitly reviewed in tests |
| Browser loading and display | Checked for all 26 variants |

582 existing values were corrected. 18 keys were added to all 26 catalogues, giving 468 new values. Free and Pro plan names, scientific method proper names and some terms identical across languages are intentionally retained.

## Issues corrected

- All 443 initial keys existed everywhere, but 16 messages were still English in 22 languages. They covered account dataset selection, login and scale measurements. Three technical labels also remained English in Canadian French.
- Isolated or partial English translations remained, particularly in Italian, Latvian, Maltese and Slovak.
- Reviewing measurement labels revealed mistranslations of body height, sex used for calculations, profile and scale snapshots at measurement time, and fat-free mass. In German, fat-free mass was notably described as muscle mass. These labels were corrected in the 22 affected languages.
- Plan badges, all scientific method titles and known scale-model origins now use keys. The technical updatedAt label uses the last-modified label when shown in additional data.
- 91 variants of storage, migration, transaction and API diagnostics were connected to translated keys. Stored messages remain readable by older versions; translation occurs on display. Several similar technical errors share a user-facing message. Paths are not translated; some generic messages omit their details. Original diagnostics remain in data and unknown external messages remain intact.
- Seven native diagnostics could display an unfilled {detail} parameter. Variants without details now use a parameter-free key; invalid transaction UUIDs include the affected name.
- Weigh-in and byte counters use wording independent of plural forms, such as “Weigh-ins: 1” and “Received: 1 B”. A choice between only two forms did not cover every language's rules.

## Verification and prevention

Tests in tauri/test/i18n.test.js check coverage, duplicates, parameters, unjustified English copies, literal references, computed keys and domain/storage error mappings. An explicit list specifies terms allowed to match English for each language.

A browser test loads every catalogue in the built application and checks the title, navigation, account data, calculation methods and account dialogue. Bluetooth and data-merge tests check the new counters.

Validation commands, from the indicated directories:

- In tauri: npm run test:ui
- In tauri: npm test
- In tauri/src-tauri: cargo test --offline --lib transactions

## Limits of the conclusion

Key and parameter coverage is checked automatically. Linguistic quality received targeted review and corrections, without native-speaker validation for every language. Tests do not provide exhaustive linguistic certification of every sentence.

User-entered data, manufacturer names, identifiers and raw Bluetooth protocol values are not translated. Diagnostics supplied directly by the system or external libraries may retain their original language. Unknown additional fields retain their technical names.

The CLI remains French and has no translation layer: cli/index.cjs contains hard-coded help and messages. It is therefore outside the graphical interface's 26 languages. The www public website has its own French/English mechanism, separate from the software audited here.

No deployment was performed as part of this audit.
