import { invoke, isTauri } from '@tauri-apps/api/core';
import { initialiseLanguage, locale, t } from './i18n.js';
import { loadLanguagePreference } from './preferences.js';
import { createPwaInstaller } from './pwa-install.js';

const installationRequested = !isTauri() && new URL(window.location.href).searchParams.get('install') === '1';
const installer = installationRequested ? createPwaInstaller(window) : null;

const [systemLocale, languagePreference] = await Promise.all([
  isTauri() ? invoke('system_locale').catch(() => undefined) : undefined,
  loadLanguagePreference().catch(() => undefined),
]);
await initialiseLanguage(systemLocale, languagePreference);
document.addEventListener('invalid', ({ target }) => {
  if (!target.validity || target.validity.customError) return;
  const validity = target.validity;
  const number = value => Number(value).toLocaleString(document.documentElement.lang);
  const message = validity.valueMissing ? t('requiredField')
    : validity.badInput ? t('numberRequired')
    : validity.typeMismatch && target.type === 'email' ? t('validEmailRequired')
    : validity.rangeUnderflow ? t('minimumValue', { min: number(target.min) })
    : validity.rangeOverflow ? t('maximumValue', { max: number(target.max) })
    : validity.stepMismatch && target.step === '1' ? t('wholeNumberRequired')
    : t('invalidField');
  target.setCustomValidity(message);
}, true);
document.addEventListener('input', ({ target }) => target.setCustomValidity?.(''));
document.addEventListener('reset', ({ target }) => {
  for (const control of target.elements) control.setCustomValidity?.('');
});

if (installer) {
  // Let the page finish loading so the browser can announce installability.
  // Account startup follows dismissal; installation needs no login.
  void installer.show(locale).then(() => import('./main.js'));
} else {
  await import('./main.js');
}
