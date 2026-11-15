import composition from 'virtual:epi-composition';
import { kg } from 'virtual:epi-domain';
import { measurementCharts } from './measurement-charts.js';
import { METHOD_COLUMNS, METRICS } from './service.js';
import { deviceFields, escapeHtml as e, formatCalendarDate, formatDate, formatScaleTime, nameKey, number, pairs, pageHeader, weight } from './format.js';

const colors = [
  ['▰','#153873','#dce9ff'], ['●','#882d16','#ffe4d7'], ['◆','#724909','#fef0c5'],
  ['▲','#27583f','#dcf2e4'], ['■','#68294f','#f7dff0'], ['⬣','#245567','#dbf0f5'],
  ['★','#583678','#eadff7'], ['◈','#12524e','#d7f0ea'], ['◇','#633d25','#f4e8dc'],
  ['✚','#672e2e','#fde1e1'], ['▣','#344767','#e1e9f3'], ['◉','#3c501a','#e8efda'],
  ['✦','#4b3476','#eae5ff'],
];
const methodSources = {
  IMC: 'https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight',
  Mi: 'https://github.com/lolouk44/xiaomi_mi_scale/blob/master/src/Xiaomi_Scale_Body_Metrics.py',
  'Sun*': 'https://doi.org/10.1093/ajcn/77.2.331',
  'Jan*': 'https://doi.org/10.1152/jappl.2000.89.2.465',
  'D60*': 'https://doi.org/10.1093/ajcn/51.1.3',
  Deu: 'https://doi.org/10.1079/bjn19910073',
  CUN: 'https://doi.org/10.2337/dc11-1334',
  Wat: 'https://doi.org/10.1093/ajcn/33.1.27',
  HW: 'https://doi.org/10.1136/jcp.24.3.234',
  MSJ: 'https://doi.org/10.1093/ajcn/51.2.241',
  HB: 'https://doi.org/10.1093/ajcn/40.1.168',
  Owe: 'https://doi.org/10.1093/ajcn/44.1.1',
  'Cun*': 'https://doi.org/10.1093/ajcn/33.11.2372',
};
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
  ['scaleTime', 'Horloge de la balance', row => formatScaleTime(row.reception?.scale?.scaleTime)],
  ['stable', 'Poids stabilisé', row => row.reception?.scale?.stable],
  ['removed', 'Charge retirée', row => row.reception?.scale?.removed],
  ['hex', 'Trame brute', row => row.reception?.raw?.hex],
  ['age', 'Âge à la pesée', row => row.profile?.ageAtWeighIn ?? row.profile?.age],
  ['heightCm', 'Taille utilisée (cm)', row => row.profile?.heightCm],
  ['sex', 'Sexe utilisé', row => row.profile?.sex],
  ['birthDate', 'Naissance du profil', row => formatCalendarDate(row.profile?.birthDate)],
];
const options = [...extras, ...METRICS].sort(([, first], [, second]) => first.localeCompare(second, 'fr'));
const chartColumnIds = new Set(['impedanceOhms', ...METRICS.map(([id]) => id)]);
const measurementColumnOrder = ['date', 'weight', ...[...extras, ...METRICS].map(([id]) => id)];
const methodColumnOrder = methods.map(({ id }) => id);
const defaultOrder = ids => ` data-default-order="${e(JSON.stringify(ids))}"`;

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

function columnSettings(selected, split, sourcesByMetric, open, query, chart) {
  const available = chart ? options.filter(([id]) => chartColumnIds.has(id)) : options;
  return `<details class="settings" data-expand="columns"${open ? ' open' : ''}>
    <summary>Données</summary>
    <div class="column-search-field">
      <input class="column-search" type="search" aria-label="Recherche" placeholder="Recherche" value="${e(query)}">
    </div>
    <div class="column-options">${available.map(([id, label]) => {
      const toggle = split.has(id) ? 'Rassembler' : 'Éclater';
      const canSplit = !chart && sourcesByMetric.get(id)?.length > 1;
      return `<div class="column-option" data-column-option="${e(label)}">
        <label><input type="checkbox" data-column="${id}"${selected.has(id) ? ' checked' : ''}>${e(label)}</label>
        ${canSplit ? `<button type="button" class="button" data-action="split-column" data-value="${id}" aria-pressed="${split.has(id)}" aria-label="${e(toggle + ' ' + label)}">${toggle}</button>` : ''}
      </div>`;
    }).join('')}</div>
  </details>`;
}

function displayButtons(chart) {
  const options = [
    ['chart', 'Graphique', '<path d="M3 3v18h18M6 16l5-5 4 3 6-8"/>'],
    ['table', 'Tableau', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/>'],
  ];
  return `<div class="measurement-display" role="group" aria-label="Visualisation des pesées">
    ${options.map(([id, label, icon]) => `<button class="button icon-button" type="button"
      data-action="measurement-display" data-value="${id}" aria-pressed="${chart === (id === 'chart')}"
      aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></button>`).join('')}
  </div>`;
}

const columnDrag = id => ` data-drag-column="${id}"`;
const sourceLink = (url, text) => `<a class="method-source" href="${e(url)}" target="_blank" rel="noopener noreferrer" draggable="false">${text}</a>`;
const methodHeader = ({ id, icon, label, style, source }, drag = '') => {
  const title = `<span aria-hidden="true">${icon}</span> ${e(id)}`;
  return `<th scope="col"${drag} class="method-header" style="${style}" title="${e(label)}"><span class="column-title">${source ? sourceLink(source, title) : title}</span></th>`;
};
const methodValue = (row, id, { id: method, style }, precision, drag = '') => `<td${drag} class="method-value numeric" style="${style}">${number(row.calculations?.[method]?.[id], precision)}</td>`;

function averageValue(row, id, sources) {
  const values = sources.map(({ id: method }) => row.calculations?.[method]?.[id]);
  return composition.average(values);
}

export function measurementsView(rows, profile, columns, splitColumns, columnOrder, expanded, query, header, display, chartOptions) {
  const selected = new Set(columns);
  const split = new Set(splitColumns);
  const sourcesByMetric = new Map(METRICS.map(([id]) => [
    id, methods.filter(method => rows.some(row => Number.isFinite(row.calculations?.[method.id]?.[id]))),
  ]));
  const chart = display === 'chart';
  const settings = profile || rows.length ? `<div class="panel measurement-settings">
    ${displayButtons(chart)}${profile ? columnSettings(selected, split, sourcesByMetric, expanded, query, chart)
      : '<div class="measurement-display-label">Visualisation</div>'}
  </div>` : '';
  const last = rows[0];
  const emptyText = profile ? 'Aucune pesée enregistrée pour ce profil.' : 'Sélectionnez un profil pour afficher ses pesées.';
  const summary = last ? `<div class="panel measurement-summary">
    <p>Dernier poids <strong>${weight(last.measures)}</strong></p><p class="muted">${formatDate(last.receivedAt)}</p>
  </div>` : '';
  header ??= pageHeader('Pesées');
  if (!last) return { header, content: `${settings}<p class="panel empty">${emptyText}</p>` };
  if (chart) {
    const series = [
      { id: 'weight', label: 'Poids (kg)', read: kg },
      { id: 'impedanceOhms', label: 'Impédance (Ω)', read: row => row.measures?.impedanceOhms ?? row.impedanceOhms },
      ...METRICS.map(([id, label]) => ({ id, label, read: row => averageValue(row, id, sourcesByMetric.get(id)) })),
    ];
    return { header, content: `${settings}${measurementCharts(rows, series, { ...chartOptions, selected })}` };
  }

  const extraColumns = [
    { id: 'date', label: 'Date', cells: row => `<td${columnDrag('date')} class="numeric"><button class="reading-date" type="button" aria-label="Voir la pesée du ${formatDate(row.receivedAt)}">${formatDate(row.receivedAt)}</button></td>` },
    { id: 'weight', label: 'Poids', cells: row => `<td${columnDrag('weight')} class="numeric"><strong>${weight(row.measures)}</strong></td>` },
    ...extras.filter(([id]) => selected.has(id)).map(([id, label, read]) => ({
      id, label, cells: row => `<td${columnDrag(id)}>${e(textValue(read(row)))}</td>`,
    })),
  ];
  const visibleMetrics = METRICS.filter(([id]) => selected.has(id)).map(([id, label, precision]) => {
    const sources = sourcesByMetric.get(id);
    const separate = split.has(id) && sources.length > 1;
    const drag = columnDrag(id);
    return {
      id, label, separate, canSplit: sources.length > 1,
      subheaders: sources.map(method => methodHeader(method, drag)),
      cells: row => `<td${drag} class="numeric">${number(averageValue(row, id, sources), precision)}</td>${
        separate ? sources.map(method => methodValue(row, id, method, precision, drag)).join('') : ''
      }`,
    };
  });
  const byId = new Map([...extraColumns, ...visibleMetrics].map(column => [column.id, column]));
  const ordered = [...new Set([...(columnOrder ?? []), ...byId.keys()])].filter(id => byId.has(id)).map(id => byId.get(id));
  const twoRows = ordered.some(({ separate }) => separate);
  const headers = ordered.map(({ id, label, canSplit, separate, subheaders }) => {
    const title = canSplit
      ? `<button class="column-toggle" type="button" data-action="split-column" data-value="${id}" aria-expanded="${Boolean(separate)}">${e(label)}</button>`
      : e(label);
    const scope = separate ? `scope="colgroup" colspan="${subheaders.length + 1}"`
      : `scope="col"${twoRows ? ' rowspan="2"' : ''}`;
    return `<th${columnDrag(id)} ${scope}><span class="column-title">${title}</span></th>`;
  }).join('');
  const content = `${summary}${settings}
    <div class="panel table-scroll pinned-header" tabindex="0" role="region" aria-label="Pesées">
      <table class="measurements-table" aria-label="Pesées"${defaultOrder(measurementColumnOrder)}>
        <thead><tr>${headers}</tr>
        ${twoRows ? `<tr>${ordered.map(({ id, separate, subheaders }) => separate
          ? `<th scope="col"${columnDrag(id)}>Moyenne</th>${subheaders.join('')}` : '').join('')}</tr>` : ''}</thead>
        <tbody>${rows.map((row, index) => `<tr data-action="reading" data-value="${index}">
          ${ordered.map(({ cells }) => cells(row)).join('')}
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  return { header, content };
}

export function measurementDetails(row, methodOrder = [], sectionOrder = [], sectionsOpen = {}, header) {
  const byId = new Map(methods.map(method => [method.id, method]));
  const activeMethods = [...new Set([...methodOrder, ...byId.keys()])].map(id => byId.get(id))
    .filter(Boolean).filter(({ id }) => METRICS.some(([metric]) => Number.isFinite(row.calculations?.[id]?.[metric])))
    .map(method => ({
      ...method,
      source: method.id === 'Owe' && row.profile?.sex === 'H'
        ? 'https://doi.org/10.1093/ajcn/46.6.875' : methodSources[method.id],
    }));
  const measures = row.measures ?? row;
  const readings = `<p><strong>${weight(measures)}</strong> · ${formatDate(row.receivedAt)}</p>`;
  const comparison = activeMethods.length ? `<div class="panel table-scroll pinned-header comparison-scroll" role="region" aria-label="Comparaison des méthodes" tabindex="0">
    <table aria-label="Comparaison des méthodes"${defaultOrder(methodColumnOrder)}><thead><tr><th scope="col">Donnée</th><th scope="col">Moyenne</th>${activeMethods.map(method => methodHeader(method, columnDrag(method.id))).join('')}</tr></thead>
    <tbody>${METRICS.filter(([id]) => activeMethods.some(method => Number.isFinite(row.calculations?.[method.id]?.[id])))
      .map(([id, label, precision]) => `<tr><th scope="row">${e(label)}</th><td class="numeric">${number(averageValue(row, id, activeMethods), precision)}</td>${activeMethods.map(method => methodValue(row, id, method, precision, columnDrag(method.id))).join('')}</tr>`).join('')}</tbody></table></div>` : '';
  const legend = activeMethods.length ? `<div class="legend">${activeMethods.map(({ icon, id, label, style, source }) => `<span style="${style}">${sourceLink(source, `${icon} ${e(id)} · ${e(label)}`)}</span>`).join('')}</div>
    <p class="muted">Les méthodes marquées d’un astérisque utilisent l’impédance pieds à pieds de la balance.</p>` : '';
  const sections = [
    ['methods', 'Méthodes de calcul', legend, false],
    ['measures', 'Mesures', pairs([
      ['Poids', number(measures.weight)],
      ['Unité', measures.unit],
      ['Impédance (Ω)', number(measures.impedanceOhms)],
    ]), false],
    ['profile', 'Profil à la pesée', row.profile && pairs([
      ['Nom', row.profile.name ?? 'Temporaire'],
      ['Sexe utilisé', row.profile.sex],
      ['Âge à la pesée', number(row.profile.ageAtWeighIn ?? row.profile.age)],
      ['Taille utilisée (cm)', number(row.profile.heightCm)],
      ['Naissance du profil', formatCalendarDate(row.profile.birthDate)],
    ]), true],
    ['reception', 'Données de réception', row.reception && pairs(extras.slice(3, 11).map(([, label, read]) => [label, textValue(read(row))])), true],
    ['device', 'Fiche de la balance à la pesée', row.device && pairs([['Nom', row.device.name], ...deviceFields(row.device)]), false],
  ];
  const known = new Set(['uuid', 'profileUuid', 'deviceUuid', 'receivedAt', 'profile', 'device', 'measures', 'calculations', 'reception']);
  if (!row.measures) for (const key of ['weight', 'unit', 'impedanceOhms']) known.add(key);
  const jsonNumber = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 1 });
  for (const [key, value] of Object.entries(row)) {
    if (known.has(key) || value == null) continue;
    const json = JSON.stringify(value, (_key, field) => typeof field === "number" ? Number(jsonNumber.format(field)) : field, 2);
    sections.push(['extra:' + key, key, `<pre>${e(json)}</pre>`, false]);
  }
  const bySection = new Map(sections.filter(([, , body]) => body).map(([id, ...section]) => [id, section]));
  const orderedSections = [...new Set([...sectionOrder, ...bySection.keys()])].filter(id => bySection.has(id));
  const content = `<div class="measurement-details"${defaultOrder(sections.map(([id]) => id))}>${readings}${comparison}${orderedSections.map(id => {
      const [title, body, defaultOpen] = bySection.get(id);
      const open = sectionsOpen[id] ?? defaultOpen;
      return `<details data-detail-section="${e(id)}"${open ? ' open' : ''}><summary>${e(title)}</summary>${body}</details>`;
    }).join('')}</div>`;
  return { header: header ?? pageHeader('Détails de la pesée'), content };
}
