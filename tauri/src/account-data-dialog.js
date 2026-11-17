import { locale, t } from './i18n.js';

const dialog = document.querySelector('#account-data-dialog');
let choosing;

function renderSummary(kind, summary = {}) {
  const count = Number.isSafeInteger(summary.count) && summary.count >= 0 ? summary.count : 0;
  document.querySelector('#account-data-' + kind + '-count').textContent =
    t('accountDataCount', { count: new Intl.NumberFormat(locale).format(count) });
  const dates = [summary.from, summary.to].map(value => value && new Date(value));
  const validDates = dates.every(date => date && Number.isFinite(+date));
  const format = date => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  document.querySelector('#account-data-' + kind + '-period').textContent = validDates
    ? t('accountDataPeriod', { from: format(dates[0]), to: format(dates[1]) })
    : t(count ? 'accountDataUnknownDates' : 'accountDataEmpty');
}

// The caller only commits the attachment after this explicit choice.
export function chooseAccountData({ local, remote }) {
  if (choosing) return choosing;
  renderSummary('local', local);
  renderSummary('remote', remote);
  dialog.returnValue = 'cancel';
  choosing = new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const choice = ['merge', 'remote'].includes(dialog.returnValue) ? dialog.returnValue : null;
      choosing = undefined;
      resolve(choice);
    }, { once: true });
    dialog.showModal();
  });
  return choosing;
}
