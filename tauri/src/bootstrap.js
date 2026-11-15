import { invoke, isTauri } from '@tauri-apps/api/core';
import { initialiseLanguage, t } from './i18n.js';
import { loadLanguagePreference } from './preferences.js';

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

await import('./main.js');
