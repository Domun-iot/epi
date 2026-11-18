import { renderInstallationGuide } from '../../shared/pwa-install.mjs';

// Capture the event before language preferences or account data are loaded.
export function createPwaInstaller(window) {
  let prompt;
  let refresh = () => {};
  let installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const beforeInstall = event => {
    event.preventDefault();
    prompt = event;
    refresh();
  };
  const onInstalled = () => {
    installed = true;
    prompt = undefined;
    refresh();
  };
  window.addEventListener('beforeinstallprompt', beforeInstall);
  window.addEventListener('appinstalled', onInstalled);
  return {
    async show(locale) {
      const document = window.document;
      const text = (fr, en) => locale.startsWith('fr') ? fr : en;
      const dialog = document.createElement('dialog');
      dialog.className = 'pwa-install-dialog';
      dialog.setAttribute('aria-labelledby', 'pwa-install-title');
      dialog.innerHTML = '<h2 id="pwa-install-title">' + text('Installer éPI', 'Install éPI') + '</h2>' +
        '<p data-install-status role="status"></p><div data-install-guide>' + renderInstallationGuide(locale, window.navigator) + '</div>' +
        '<div class="actions"><button type="button" class="button" data-install-close>' + text('Continuer vers éPI', 'Continue to éPI') + '</button>' +
        '<button type="button" class="button primary" data-install-prompt hidden>' + text('Installer éPI', 'Install éPI') + '</button></div>';
      const button = dialog.querySelector('[data-install-prompt]');
      const status = dialog.querySelector('[data-install-status]');
      refresh = () => {
        button.hidden = installed || !prompt;
        dialog.querySelector('[data-install-guide]').hidden = installed;
        status.textContent = installed ? text('éPI est installée. Retrouvez-la parmi vos applications.', 'éPI is installed. Find it among your apps.')
          : prompt ? text('L’installation est prête. Cliquez sur « Installer éPI », puis confirmez dans votre navigateur.', 'Installation is ready. Click “Install éPI”, then confirm in your browser.')
          : text('Installez éPI depuis le menu de votre navigateur en suivant ces étapes.', 'Install éPI from your browser menu by following these steps.');
      };
      refresh();
      button.addEventListener('click', async () => {
        const current = prompt;
        if (!current) return;
        prompt = undefined;
        button.disabled = true;
        try {
          const { outcome } = await current.prompt();
          if (outcome === 'accepted') installed = true;
          refresh();
        } catch {
          refresh();
          status.textContent = text('L’installation n’a pas pu démarrer. Utilisez le menu du navigateur ci-dessous.', 'Installation could not start. Use the browser menu below.');
        } finally {
          button.disabled = false;
        }
      });
      dialog.querySelector('[data-install-close]').addEventListener('click', () => dialog.close());
      document.body.append(dialog);
      await new Promise(resolve => {
        dialog.addEventListener('close', resolve, { once: true });
        dialog.showModal();
      });
      dialog.remove();
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      refresh = () => {};
      const url = new URL(window.location.href);
      url.searchParams.delete('install');
      window.history.replaceState(window.history.state, '', url);
    },
  };
}
