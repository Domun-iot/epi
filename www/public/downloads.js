import { renderInstallationGuide } from './pwa-install.mjs';

const guide = document.querySelector('[data-pwa-guide]');
if (guide) {
  const fr = document.querySelector('.download-section').lang === 'fr';
  guide.innerHTML = renderInstallationGuide(fr ? 'fr' : 'en', navigator, true);
  const summary = guide.closest('details').querySelector('summary');
  const dialog = document.createElement('dialog');
  dialog.id = 'pwa-help-dialog';
  dialog.className = 'pwa-help-dialog';
  dialog.setAttribute('aria-labelledby', 'pwa-help-title');
  dialog.innerHTML = '<h2 id="pwa-help-title">' + (fr ? 'Installer éPI' : 'Install éPI') + '</h2>' +
    guide.innerHTML + '<form method="dialog" class="pwa-help-actions"><button class="button">' +
    (fr ? 'Fermer' : 'Close') + '</button><a class="button" href="https://epi.domun.eu/?install=1">' +
    (fr ? 'Installer éPI' : 'Install éPI') + '</a></form>';
  document.body.append(dialog);
  summary.setAttribute('aria-haspopup', 'dialog');
  summary.setAttribute('aria-controls', dialog.id);
  summary.addEventListener('click', event => {
    event.preventDefault();
    dialog.showModal();
  });
}
