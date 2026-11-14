import composition from 'virtual:epi-composition';
import { METHOD_COLUMNS, METRICS } from './service.js';
import { deviceFields, escapeHtml as e, formatDate, nameKey, number, pairs, pageHeader, weight } from './format.js';

const colors = [
  ['▰','#153873','#dce9ff'], ['●','#882d16','#ffe4d7'], ['◆','#724909','#fef0c5'],
  ['▲','#27583f','#dcf2e4'], ['■','#68294f','#f7dff0'], ['⬣','#245567','#dbf0f5'],
  ['★','#583678','#eadff7'], ['◈','#12524e','#d7f0ea'], ['◇','#633d25','#f4e8dc'],
  ['✚','#672e2e','#fde1e1'], ['▣','#344767','#e1e9f3'], ['◉','#3c501a','#e8efda'],
  ['✦','#4b3476','#eae5ff'],
];
const methods = METHOD_COLUMNS.map(([id, label], index) => {
  const [icon, ink, bg] = colors[index % colors.length];
  return { id, label, icon, style: `--method-ink:${ink};--method-bg:${bg}` };
});
const extras = [
  ['impedanceOhms', 'Impédance (Ω)', row => row.measures?.impedanceOhms],
  ['unit', 'Unité', row => row.measures?.unit],
  ['device', 'Appareil', row => row.device?.name],
  ['address', 'Adresse Bluetooth', row => row.reception?.bluetooth?.address ?? row.device?.bluetooth?.address],
  ['serviceUuid', 'Identifiant du service', row => row.reception?.bluetooth?.serviceUuid],
  ['service', 'Service Bluetooth', row => row.reception?.bluetooth?.service],
  ['rssiDbm', 'Signal Bluetooth (dBm)', row => row.reception?.bluetooth?.rssiDbm],
  ['scaleTime', 'Horloge de la balance', row => row.reception?.scale?.scaleTime],
  ['stable', 'Poids stabilisé', row => row.reception?.scale?.stable],
  ['removed', 'Charge retirée', row => row.reception?.scale?.removed],
  ['hex', 'Trame brute', row => row.reception?.raw?.hex],
  ['age', 'Âge utilisé', row => row.profile?.age],
  ['heightCm', 'Taille utilisée (cm)', row => row.profile?.heightCm],
  ['sex', 'Sexe utilisé', row => row.profile?.sex],
  ['birthDate', 'Naissance du profil', row => row.profile?.birthDate],
];
const options = [...extras, ...METRICS].sort(([, first], [, second]) => first.localeCompare(second, 'fr'));

export function filterColumnOptions(panel, query) {
  const groups = nameKey(query).split(',').map(group => group.trim().split(/\s+/)).filter(([first]) => first);
  for (const option of panel.querySelectorAll('[data-column-option]')) {
    const label = nameKey(option.dataset.columnOption);
    option.hidden = groups.length > 0 && !groups.some(words => words.every(word => label.includes(word)));
  }
}

function textValue(value) {
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'number') return number(value);
  return value ?? '—';
}

function columnSettings(selected, split, sourcesByMetric, open, query) {
  return `<details class="panel settings" data-expand="columns"${open ? ' open' : ''}>
    <summary>Colonnes</summary>
    <input class="column-search" type="search" aria-label="Recherche" placeholder="Recherche" value="${e(query)}">
    <div class="column-options">${options.map(([id, label]) => {
      const toggle = split.has(id) ? 'Rassembler' : 'Éclater';
      const canSplit = sourcesByMetric.get(id)?.length > 1;
      return `<div class="column-option" data-column-option="${e(label)}">
        <label><input type="checkbox" data-column="${id}"${selected.has(id) ? ' checked' : ''}>${e(label)}</label>
        ${canSplit ? `<button type="button" class="button" data-action="split-column" data-value="${id}" aria-pressed="${split.has(id)}" aria-label="${e(toggle + ' ' + label)}">${toggle}</button>` : ''}
      </div>`;
    }).join('')}</div>
  </details>`;
}

const methodHeader = ({ id, icon, label, style }) => `<th scope="col" class="method-header" style="${style}" title="${e(label)}"><span aria-hidden="true">${icon}</span> ${e(id)}</th>`;
const methodValue = (row, id, { id: method, style }, precision) => `<td class="method-value numeric" style="${style}">${number(row.calculations?.[method]?.[id], precision)}</td>`;

function averageValue(row, id, sources) {
  const values = sources.map(({ id: method }) => row.calculations?.[method]?.[id]);
  return composition.average(values);
}

export function measurementsView(rows, profile, columns, splitColumns, expanded, query) {
  const selected = new Set(columns);
  const split = new Set(splitColumns);
  const sourcesByMetric = new Map(METRICS.map(([id]) => [
    id, methods.filter(method => rows.some(row => Number.isFinite(row.calculations?.[method.id]?.[id]))),
  ]));
  const visibleExtras = extras.filter(([id]) => selected.has(id));
  const visibleMetrics = METRICS.filter(([id]) => selected.has(id)).map(([id, label, precision]) => {
    const sources = sourcesByMetric.get(id);
    return { id, label, precision, sources, separate: split.has(id) && sources.length > 1 };
  });
  const twoRows = visibleMetrics.some(({ separate }) => separate);
  const metricGroups = visibleMetrics.map(({ label, sources, separate }) => separate
    ? `<th scope="colgroup" colspan="${sources.length}">${e(label)}</th>`
    : `<th scope="col"${twoRows ? ' rowspan="2"' : ''}>${e(label)}</th>`).join('');
  const headers = ['Date', 'Poids', ...visibleExtras.map(([, label]) => label)]
    .map(label => `<th scope="col"${twoRows ? ' rowspan="2"' : ''}>${e(label)}</th>`).join('');
  const settings = profile ? columnSettings(selected, split, sourcesByMetric, expanded, query) : '';
  const last = rows[0];
  const emptyText = profile ? 'Aucune pesée enregistrée pour ce profil.' : 'Sélectionnez un profil pour afficher ses pesées.';
  const content = last ? `<div class="panel measurement-summary">
      <p>Dernier poids <strong>${weight(last.measures)}</strong></p><p class="muted">${formatDate(last.receivedAt)}</p>
    </div>${settings}
    <div class="panel table-scroll" tabindex="0" role="region" aria-label="Pesées">
      <table aria-label="Pesées">
        <thead><tr>${headers}${metricGroups}</tr>
        ${twoRows ? `<tr>${visibleMetrics.flatMap(({ sources, separate }) => separate ? sources.map(methodHeader) : []).join('')}</tr>` : ''}</thead>
        <tbody>${rows.map((row, index) => `<tr data-action="reading" data-value="${index}">
          <td class="numeric"><button class="reading-date" type="button" aria-label="Voir la pesée du ${formatDate(row.receivedAt)}">${formatDate(row.receivedAt)}</button></td><td class="numeric"><strong>${weight(row.measures)}</strong></td>
          ${visibleExtras.map(([, , read]) => `<td>${e(textValue(read(row)))}</td>`).join('')}
          ${visibleMetrics.map(({ id, precision, sources, separate }) => separate
            ? sources.map(method => methodValue(row, id, method, precision)).join('')
            : `<td class="numeric">${number(averageValue(row, id, sources), precision)}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table>
    </div>` : `${settings}<p class="panel empty">${emptyText}</p>`;
  return pageHeader('Pesées') + content;
}

export function measurementDetails(row) {
  const activeMethods = methods.filter(({ id }) => METRICS.some(([metric]) => Number.isFinite(row.calculations?.[id]?.[metric])));
  const readings = `<p><strong>${weight(row.measures)}</strong> · ${formatDate(row.receivedAt)}</p>`;
  const comparison = activeMethods.length ? `<div class="panel table-scroll" role="region" aria-label="Comparaison des méthodes" tabindex="0">
    <table aria-label="Comparaison des méthodes"><thead><tr><th scope="col">Donnée</th><th scope="col">Moyenne</th>${activeMethods.map(methodHeader).join('')}</tr></thead>
    <tbody>${METRICS.filter(([id]) => activeMethods.some(method => Number.isFinite(row.calculations?.[method.id]?.[id])))
      .map(([id, label, precision]) => `<tr><th scope="row">${e(label)}</th><td class="numeric">${number(averageValue(row, id, activeMethods), precision)}</td>${activeMethods.map(method => methodValue(row, id, method, precision)).join('')}</tr>`).join('')}</tbody></table></div>
    <details><summary>Méthodes de calcul</summary><div class="legend">${activeMethods.map(({ icon, id, label, style }) => `<span style="${style}">${icon} ${e(id)} · ${e(label)}</span>`).join('')}</div>
    <p class="muted">Les méthodes marquées d’un astérisque utilisent l’impédance pieds à pieds de la balance.</p></details>` : '';
  return pageHeader('Détails de la pesée')
    + `<div class="measurement-details">${readings}${comparison}<details open><summary>Données de réception</summary>${pairs(extras.map(([, label, read]) => [label, textValue(read(row))]))}</details>`
    + (row.device ? `<details><summary>Fiche de la balance à la pesée</summary>${pairs(deviceFields(row.device))}</details>` : '') + '</div>';
}
