# Site public éPI

Lancer avec `npm --prefix www start`, puis ouvrir http://127.0.0.1:3002/epi.
Node.js 22.13 ou supérieur suffit ; Node.js 24 est utilisé pour la vérification du projet.
Les tests HTTP se lancent avec `npm --prefix www test`.

La langue suit cet ordre : paramètre `?lang=fr`, cookie, préférences du navigateur,
anglais britannique. Les URL restent identiques dans toutes les langues.

## Configuration et interfaces

- `EPI_WWW_PORT` change le port local.
- `DOMUN_SOFTWARE_CATALOG_URL` fournit le catalogue JSON utilisé par la page Pro.
  Les tests injectent un serveur local : aucun paiement n'est nécessaire pour développer le site.
- `EPI_WWW_SECURE_COOKIE=1` active l'attribut Secure du cookie de langue.
- `EPI_WWW_RETENTION_FILE` désigne un JSON de textes de confidentialité, indexé
  par les codes de langue de `locales.js`. Ce fichier local reste hors Git.

Le site affiche les offres et dirige vers le service de compte externe. Il ne réalise
pas les encaissements. `/epi/plan-features.json` expose la grille de fonctionnalités.
Le lien de suppression et l'ancienne route `/epi/delete-account` dirigent vers le service de compte.

## Pages développeurs et ressources

`/epi/developers`, `/epi/developers/guide` et `/epi/download` décrivent les versions disponibles.
Le guide public lit uniquement [BUILD.md](../docs/BUILD.md).
Les tests de téléchargements utilisent des fichiers temporaires et ne modifient aucune release réelle.
La capture `public/weigh-ins.jpg` représente des données fictives en mode simulation.

Les logos SVG viennent de `public/logos/` (Devicon, licence MIT ; Simple Icons, CC0 ;
voir les licences jointes). Les marques restent celles de leurs propriétaires.
Le logo PWA suit le navigateur identifié par User-Agent, avec une icône web générique
en repli. Aucun service tiers n'est chargé pour ces logos.

## Comportements et tests du site

Le volet PWA ouvre une fenêtre avec une liste numérotée adaptée au navigateur et au système courants ; sans JavaScript, il reste déroulant. Le script affine aussi la détection des iPad utilisant un User-Agent de Mac. « Installer éPI » ouvre `https://epi.domun.eu/?install=1` : l’application affiche une fenêtre d’installation avant le démarrage du compte, puis un bouton natif dès réception de `beforeinstallprompt`. Sans cet événement (Safari, Firefox ou installation indisponible), les étapes manuelles restent accessibles. Une application déjà ouverte en mode installé affiche une confirmation. La page de téléchargements ne peut pas déclencher directement l’installation de l’autre domaine. Les instructions communes sont dans `shared/pwa-install.mjs`.

