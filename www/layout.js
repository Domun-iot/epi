import { catalog, locales } from './locales.js';

export const playUrl = 'https://play.google.com/store/apps/details?id=fr.epi.balance';
export const playIcon = base => '<img src="' + base + '/assets/google-play.svg" alt="" width="24" height="24">';

const navigation = {
  "bg": [
    "Назад към началото",
    "Изтриване на акаунт"
  ],
  "cs": [
    "Zpět na úvod",
    "Smazání účtu"
  ],
  "da": [
    "Tilbage til forsiden",
    "Sletning af konto"
  ],
  "de": [
    "Zurück zur Startseite",
    "Konto löschen"
  ],
  "el": [
    "Επιστροφή στην αρχική",
    "Διαγραφή λογαριασμού"
  ],
  "en": [
    "Back to the home page",
    "Account deletion"
  ],
  "es": [
    "Volver al inicio",
    "Eliminar cuenta"
  ],
  "et": [
    "Tagasi avalehele",
    "Konto kustutamine"
  ],
  "fi": [
    "Takaisin etusivulle",
    "Tilin poistaminen"
  ],
  "fr": [
    "Retour à l’accueil",
    "Suppression de compte"
  ],
  "ga": [
    "Ar ais go dtí an baile",
    "Scriosadh cuntais"
  ],
  "hr": [
    "Povratak na početnu",
    "Brisanje računa"
  ],
  "hu": [
    "Vissza a főoldalra",
    "Fiók törlése"
  ],
  "it": [
    "Torna alla home",
    "Eliminazione account"
  ],
  "lt": [
    "Grįžti į pradžią",
    "Paskyros ištrynimas"
  ],
  "lv": [
    "Atpakaļ uz sākumlapu",
    "Konta dzēšana"
  ],
  "mt": [
    "Lura għall-paġna ewlenija",
    "Tħassir tal-kont"
  ],
  "nl": [
    "Terug naar de startpagina",
    "Account verwijderen"
  ],
  "pl": [
    "Powrót do strony głównej",
    "Usunięcie konta"
  ],
  "pt": [
    "Voltar ao início",
    "Eliminar conta"
  ],
  "ro": [
    "Înapoi la pagina principală",
    "Ștergerea contului"
  ],
  "sk": [
    "Späť na úvod",
    "Odstránenie účtu"
  ],
  "sl": [
    "Nazaj na začetno stran",
    "Izbris računa"
  ],
  "sv": [
    "Tillbaka till startsidan",
    "Radera konto"
  ]
};
const flagOverrides = { cs: 'cz', da: 'dk', el: 'gr', et: 'ee', ga: 'ie', sl: 'si', sv: 'se' };
export const flags = Object.fromEntries(Object.keys(locales).map(locale =>
  [locale, flagOverrides[locale] ?? locale.split('-').at(-1).toLowerCase()],
));

function renderLanguagePicker(base, path, locale) {
  const label = key => '<img class="flag" src="' + base + '/assets/flags/' + flags[key] +
    '.svg" alt="" width="20" height="15"><span lang="' + key + '">' + locales[key] + '</span>';
  const links = Object.keys(locales).map(key => '<li><a href="' + path + '?lang=' + key + '"' +
    (key === locale ? ' aria-current="true"' : '') + '>' + label(key) + '</a></li>').join('');
  return '<details class="languages"><summary><span class="sr-only">' + catalog[locale].language +
    ' </span>' + label(locale) + '</summary><ul class="language-options">' + links + '</ul></details>';
}

export function renderHeader(base, path, locale, home) {
  const [back] = navigation[locale.split('-')[0]];
  return '<header><div class="header-brand"><a class="brand" href="' + base +
    '"><img src="' + base + '/assets/epi.svg" alt="" width="35" height="35">éPI</a>' +
    (home ? '' : '<a class="back-link" href="' + base + '"><span aria-hidden="true">← </span>' + back + '</a>') +
    '</div><div class="header-actions"><a class="header-play" href="' + playUrl +
    '" aria-label="éPI · Google Play" title="Google Play">' + playIcon(base) + '</a>' +
    renderLanguagePicker(base, path, locale) + '</div></header>';
}

export function renderFooter(base, locale) {
  const t = catalog[locale];
  const [, deletion] = navigation[locale.split('-')[0]];
  return '<footer><span class="footer-brand"><a href="https://domun.eu/">Domun</a> by ' +
    '<a href="https://logisan.fr/">Logisan</a></span><a class="footer-deletion" href="' + base +
    '/delete-account">' + deletion + '</a><nav><a href="' + base + '/privacy-policy">' + t.privacy +
    '</a><a href="' + base + '/legal-notice">' + t.legal + '</a></nav></footer>';
}
