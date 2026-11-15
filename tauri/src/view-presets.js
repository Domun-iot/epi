import { t, htmlText } from './i18n.js';
import { deleteButton, escapeHtml as e, sortByName } from './format.js';

export const viewPresetTitles = { measurements: t('weighIns'), details: t('weighInDetails') };
const icons = {
  rename: '<path d="m15 5 4 4M4 20l4-.8L20 7l-4-4L4 15z"/>',
  save: '<path d="M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2 6m2-12v6h-6"/>',
};

function icon(action) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[action]}</svg>`;
}

function iconButton(action, label) {
  return `<button type="button" class="button view-preset-icon" data-action="${action}-view-preset"
    title="${e(label)}" aria-label="${e(label)}">${icon(action)}</button>`;
}

export function viewPresetHeader(kind, { presets, preset, modified, modifiedInactiveIds }, extraActions = '') {
  const defaultTitle = viewPresetTitles[kind];
  const current = preset?.name ?? defaultTitle;
  const choices = [{ id: '', name: defaultTitle }, ...sortByName(presets)];
  const activeId = preset?.id ?? '';
  const options = choices.filter(({ id }) => id !== activeId || modified).map(({ id, name }) => {
    const reload = id === activeId;
    if (modifiedInactiveIds.includes(id || null)) {
      return `<li class="view-preset-split">
        <button class="button" type="button" data-action="select-view-preset" data-value="${e(id)}">${e(name)} *</button>
        <button class="button view-preset-icon" type="button" data-action="reset-view-preset" data-value="${e(id)}"
          title="${htmlText('reloadNamedViewPreset', { name })}" aria-label="${htmlText('reloadNamedViewPreset', { name })}">${icon('reload')}</button>
      </li>`;
    }
    return `<li><button class="button" type="button" data-action="${reload ? 'reset' : 'select'}-view-preset" data-value="${e(id)}"${reload ? ` title="${htmlText('reloadPreset')}"` : ''}><span>${e(name)}</span>${reload ? icon('reload') : ''}</button></li>`;
  }).join('');
  const heading = `<h1>${e(current)}${modified ? ' *' : ''}</h1>`;
  return `<header class="page-header view-preset-header">
    <div class="view-preset-title">
      ${options ? `<details class="view-preset-picker">
        <summary${modified ? '' : ' class="view-preset-chevron"'}>${heading}</summary>
        <ul aria-label="${htmlText('viewPresets')}">${options}</ul>
      </details>` : heading}
      ${preset || modified ? iconButton('rename', t('renameViewPreset')) : ''}
    </div>
    <div class="view-preset-actions">
      ${preset ? deleteButton(t('deleteViewPreset'), 'delete-view-preset') : ''}
      ${modified ? iconButton('save', t('saveViewPreset')) : ''}
      ${extraActions}
    </div>
  </header>`;
}
