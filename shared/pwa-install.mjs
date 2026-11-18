const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function installationGuide(locale, { userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  const text = (fr, en) => locale.startsWith('fr') ? fr : en;
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (/Mac/i.test(platform) && maxTouchPoints > 1);
  const android = /Android/i.test(userAgent);
  const browser = /Edg(?:e|A|iOS)?\//i.test(userAgent) ? 'Edge'
    : /OPR\/|Opera|OPiOS\//i.test(userAgent) ? 'Opera'
    : /Firefox\/|FxiOS\//i.test(userAgent) ? 'Firefox'
    : /Chrome\/|CriOS\//i.test(userAgent) ? 'Chrome'
    : /Safari\//i.test(userAgent) ? 'Safari' : '';
  let steps;
  if (ios) {
    steps = [
      text('Ouvrez le menu Partager de votre navigateur.', 'Open your browser’s Share menu.'),
      text('Choisissez « Sur l’écran d’accueil ». Si nécessaire, affichez toutes les actions du menu.', 'Choose “Add to Home Screen”. If needed, show all menu actions.'),
      text('Activez « Ouvrir comme app » si cette option apparaît, puis touchez « Ajouter ».', 'Enable “Open as Web App” if shown, then tap “Add”.'),
    ];
  } else if (browser === 'Safari') {
    steps = [text('Dans Safari, ouvrez le menu Fichier, puis « Ajouter au Dock » (macOS Sonoma ou ultérieur).', 'In Safari, open the File menu, then “Add to Dock” (macOS Sonoma or later).'),
      text('Confirmez avec « Ajouter ».', 'Confirm with “Add”.')];
  } else if (browser === 'Firefox' && !android && !/Windows/i.test(userAgent)) {
    steps = [text('Firefox ne propose pas l’installation d’applications web sur ce système. Vous pouvez utiliser éPI dans cet onglet.', 'Firefox does not offer web app installation on this system. You can use éPI in this tab.')];
  } else if (browser === 'Firefox' && !android) {
    steps = [text('Cliquez sur l’icône d’application web dans la barre d’adresse (Firefox 143 ou ultérieur sous Windows).', 'Click the web app icon in the address bar (Firefox 143 or later on Windows).'),
      text('Si Windows le propose, confirmez l’épinglage à la barre des tâches.', 'If Windows asks, confirm pinning to the taskbar.')];
  } else if (browser === 'Edge' && !android) {
    steps = [text('Ouvrez le menu ⋯, puis « Applications » → « Installer ce site en tant qu’application ».', 'Open the ⋯ menu, then “Apps” → “Install this site as an app”.'), text('Confirmez avec « Installer ».', 'Confirm with “Install”.')];
  } else if (browser === 'Chrome' && !android) {
    steps = [text('Cliquez sur l’icône d’installation dans la barre d’adresse, ou ouvrez ⋮ → « Caster, enregistrer et partager » → « Installer la page en tant qu’appli ».', 'Click the install icon in the address bar, or open ⋮ → “Cast, save, and share” → “Install page as app”.'), text('Confirmez avec « Installer ».', 'Confirm with “Install”.')];
  } else {
    steps = [text('Ouvrez le menu du navigateur, puis choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil », si cette option est proposée.', 'Open the browser menu, then choose “Install app” or “Add to Home Screen”, if available.'),
      text('Confirmez l’ajout d’éPI.', 'Confirm adding éPI.')];
  }
  return {
    heading: ios ? browser + ' · iPhone / iPad' : browser + (android ? ' · Android' : ''),
    steps,
  };
}

export function renderInstallationGuide(locale, navigator, includeOpenLink = false) {
  const fr = locale.startsWith('fr');
  const guide = installationGuide(locale, navigator);
  return (guide.heading ? '<p class="pwa-browser">' + escape(guide.heading) + '</p>' : '') +
    '<ol class="pwa-steps">' + (includeOpenLink ? '<li><a href="https://epi.domun.eu/?install=1">' +
      (fr ? 'Ouvrez éPI' : 'Open éPI') + '</a> ' + (fr ? 'dans ce navigateur.' : 'in this browser.') + '</li>' : '') +
    guide.steps.map(step => '<li>' + escape(step) + '</li>').join('') + '</ol>';
}
