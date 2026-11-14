import { escapeHtml as e, sortByName } from './format.js';

export const viewPresetTitles = { measurements: 'Pesées', details: 'Détails de la pesée' };
const icons = {
  rename: '<path d="m15 5 4 4M4 20l4-.8L20 7l-4-4L4 15z"/>',
  save: '<path d="M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8"/>',
  delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2 6m2-12v6h-6"/>',
};

function icon(action) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[action]}</svg>`;
}

function iconButton(action, label) {
  return `<button type="button" class="button view-preset-icon" data-action="${action}-view-preset"
    title="${label}" aria-label="${label}">${icon(action)}</button>`;
}

export function viewPresetHeader(kind, { presets, preset, modified }) {
  const defaultTitle = viewPresetTitles[kind];
  const current = preset?.name ?? defaultTitle;
  const choices = [{ id: '', name: defaultTitle }, ...sortByName(presets)];
  const activeId = preset?.id ?? '';
  const options = choices.filter(({ id }) => id !== activeId || modified).map(({ id, name }) => {
    const reload = id === activeId;
    return `<li><button class="button" type="button" data-action="select-view-preset" data-value="${e(id)}"${reload ? ' title="Recharger la configuration"' : ''}><span>${e(name)}</span>${reload ? icon('reload') : ''}</button></li>`;
  }).join('');
  const heading = `<h1>${e(current)}${modified ? ' *' : ''}</h1>`;
  return `<header class="page-header view-preset-header">
    <div class="view-preset-title">
      ${options ? `<details class="view-preset-picker">
        <summary${modified ? '' : ' class="view-preset-chevron"'}>${heading}</summary>
        <ul aria-label="Configurations de vue">${options}</ul>
      </details>` : heading}
      ${preset || modified ? iconButton('rename', 'Renommer la configuration') : ''}
    </div>
    <div class="view-preset-actions">
      ${preset ? iconButton('delete', 'Supprimer la configuration') : ''}
      ${modified ? iconButton('save', 'Sauvegarder la configuration') : ''}
    </div>
  </header>`;
}
