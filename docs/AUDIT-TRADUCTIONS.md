# Audit des traductions — 17 novembre 2026

L’interface utilisateur commune aux versions Tauri (PC et Android), web personnelle et web hébergée utilise 26 variantes linguistiques. L’audit porte sur ses catalogues, ses écrans et les diagnostics applicatifs qui lui parviennent.

## Résultat

| Contrôle | Résultat après correction |
| --- | --- |
| Variantes linguistiques | 26 |
| Clés par catalogue | 461 |
| Valeurs au total | 11 986 |
| Clés absentes, supplémentaires, dupliquées ou vides | Aucune détectée |
| Paramètres de substitution | Identiques au catalogue anglais pour chaque clé |
| Références littérales dans l’interface et les diagnostics natifs | Toutes présentes |
| Clés calculées des méthodes et des indicateurs | Toutes présentes |
| Copies anglaises identiques | Uniquement les termes communs et noms propres explicitement revus dans les tests |
| Chargement et affichage dans le navigateur | Vérifiés pour les 26 variantes |

582 valeurs existantes ont été corrigées. 18 clés ont été ajoutées dans les 26 catalogues, soit 468 nouvelles valeurs. Les noms des offres Free et Pro, les noms propres des méthodes scientifiques et certains termes identiques entre langues sont conservés intentionnellement.

## Écarts corrigés

- Les 443 clés initiales existaient partout, mais 16 messages étaient encore en anglais dans 22 langues. Ils concernaient le choix des données de compte, la connexion et les mesures remontées par les balances. Trois libellés techniques étaient également restés en anglais en français canadien.
- Des traductions anglaises isolées ou partielles subsistaient notamment en italien, letton, maltais et slovaque.
- La relecture des libellés de mesure a mis au jour des contresens sur la taille corporelle, le sexe utilisé pour les calculs, les profils et balances au moment de la pesée, et la masse maigre. En allemand, la masse maigre était notamment présentée comme une masse musculaire. Ces libellés ont été corrigés dans les 22 langues concernées.
- Les badges des offres, tous les intitulés de méthodes scientifiques et les origines connues du modèle de balance passent maintenant par des clés. Le libellé technique updatedAt utilise celui de la dernière modification lorsqu’il apparaît dans les données supplémentaires.
- 91 variantes de diagnostics de stockage, de migration, de transactions ou d’API ont été raccordées aux clés traduites. Les messages stockés restent lisibles avec les anciennes versions ; la traduction intervient à l’affichage. Plusieurs erreurs techniques proches partagent un message utilisateur commun. Les chemins ne sont pas traduits ; certains messages génériques n’en affichent pas le détail. Les diagnostics d’origine restent conservés dans les données et les messages externes inconnus restent intacts.
- Sept diagnostics natifs pouvaient afficher un paramètre {detail} non renseigné. Les variantes sans détail utilisent désormais une clé sans paramètre ; les UUID de transaction invalides incluent le nom concerné.
- Les compteurs de pesées et d’octets utilisent une formulation indépendante du pluriel : par exemple « Pesées : 1 » et « Reçus : 1 o ». Le choix entre deux formes seulement ne couvrait pas les règles de toutes les langues.

## Vérification et prévention

Les tests dans tauri/test/i18n.test.js vérifient la couverture, les doublons, les paramètres, les copies anglaises non justifiées, les références littérales, les clés calculées et les correspondances des erreurs du domaine et du stockage. Une liste explicite précise les termes qui peuvent être identiques à l’anglais, langue par langue.

Un test de navigateur charge chaque catalogue dans l’application construite et vérifie le titre, la navigation, les données de compte, les méthodes de calcul et le dialogue de compte. Les tests Bluetooth et de fusion de données vérifient les nouveaux compteurs.

Commandes de validation, depuis les répertoires indiqués :

- Dans tauri : npm run test:ui
- Dans tauri : npm test
- Dans tauri/src-tauri : cargo test --offline --lib transactions

## Limites de la conclusion

La couverture des clés et des paramètres est vérifiée automatiquement. La qualité linguistique a fait l’objet d’une relecture ciblée et de corrections, sans validation par un locuteur natif pour chacune des langues. Les tests ne constituent pas une certification linguistique exhaustive de chaque phrase.

Les données saisies par les utilisateurs, les noms de fabricants, les identifiants et les valeurs brutes de protocole Bluetooth ne sont pas traduits. Les diagnostics fournis directement par le système ou une bibliothèque externe peuvent conserver leur langue d’origine. Les champs supplémentaires inconnus restent présentés avec leur nom technique.

La CLI est toujours en français et ne possède pas de couche de traduction : cli/index.cjs contient notamment l’aide et des messages codés en dur. Elle n’est donc pas couverte par les 26 langues de l’interface graphique. Le site vitrine www possède son propre mécanisme français/anglais ; il est distinct du logiciel audité ici.

Aucun déploiement n’a été effectué dans le cadre de cet audit.
