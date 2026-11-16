import { locale, t, htmlText } from './i18n.js';
import composition from 'virtual:epi-composition';
import { kg } from 'virtual:epi-domain';
import { measurementCharts } from './measurement-charts.js';
import { METHOD_COLUMNS, METRICS } from './service.js';
import { deviceFields, escapeHtml as e, formatCalendarDate, formatDate, formatDateMinutes, formatScaleTime, nameKey, number, pairs, pageHeader, weight } from './format.js';

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
const methodName = id => id === 'IMC' ? t('bmiShort') : id;
const methods = METHOD_COLUMNS.map(([id, label], index) => {
  const [icon, ink, bg] = colors[index % colors.length];
  return { id, label, icon, style: `--method-ink:${ink};--method-bg:${bg}` };
});
const extras = [
  ['impedanceOhms', t('impedanceOhms'), row => row.measures?.impedanceOhms],
  ['unit', t('unit'), row => row.measures?.unit],
  ['device', t('device'), row => row.device?.name],
  ['address', t('bluetoothAddress'), row => row.reception?.bluetooth?.address ?? row.device?.bluetooth?.address],
  ['serviceUuid', t('serviceId'), row => row.reception?.bluetooth?.serviceUuid],
  ['service', t('bluetoothService'), row => row.reception?.bluetooth?.service],
  ['rssiDbm', t('bluetoothSignalDbm'), row => row.reception?.bluetooth?.rssiDbm],
  ['scaleTime', t('scaleClock'), row => formatScaleTime(row.reception?.scale?.scaleTime)],
  ['stable', t('stabilisedWeight'), row => row.reception?.scale?.stable],
  ['removed', t('loadRemoved'), row => row.reception?.scale?.removed],
  ['hex', t('rawFrame'), row => row.reception?.raw?.hex],
  ['age', t('ageAtWeighIn'), row => row.profile?.ageAtWeighIn ?? row.profile?.age],
  ['heightCm', t('heightUsedCm'), row => row.profile?.heightCm],
  ['sex', t('sexUsed'), row => sexLabel(row.profile?.sex)],
  ['birthDate', t('profileDateOfBirth'), row => formatCalendarDate(row.profile?.birthDate)],
];
const options = [...extras, ...METRICS].sort(([, first], [, second]) => first.localeCompare(second, locale));
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

const sexLabel = sex => sex === 'F' ? t('female') : sex === 'H' ? t('male') : sex;

function textValue(value) {
  if (typeof value === 'boolean') return value ? t('yes') : t('no');
  if (typeof value === 'number') return number(value);
  return value ?? '—';
}

function columnSettings(selected, split, sourcesByMetric, open, query, chart) {
  const available = chart ? options.filter(([id]) => chartColumnIds.has(id)) : options;
  return `<details class="settings" data-expand="columns"${open ? ' open' : ''}>
    <summary>${htmlText('data')}</summary>
    <div class="column-search-field">
      <input class="column-search" type="search" aria-label="${htmlText('filterData')}" placeholder="${htmlText('filterData')}" value="${e(query)}">
    </div>
    <div class="column-options">${available.map(([id, label]) => {
      const toggle = split.has(id) ? t('recombineColumns') : t('splitColumns');
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
    ['chart', t('chart'), '<path d="M3 3v18h18M6 16l5-5 4 3 6-8"/>'],
    ['table', t('table'), '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M10 9v11"/>'],
  ];
  return `<div class="measurement-display" role="group" aria-label="${htmlText('weighInDisplay')}">
    ${options.map(([id, label, icon]) => `<button class="button icon-button" type="button"
      data-action="measurement-display" data-value="${id}" aria-pressed="${chart === (id === 'chart')}"
      aria-label="${e(label)}" title="${e(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></button>`).join('')}
  </div>`;
}

const columnDrag = id => ` data-drag-column="${id}"`;
const sourceLink = (url, text) => `<a class="method-source" href="${e(url)}" target="_blank" rel="noopener noreferrer" draggable="false">${text}</a>`;
const methodHeader = ({ id, icon, label, style, source }, drag = '') => {
  const title = `<span aria-hidden="true">${icon}</span> ${e(methodName(id))}`;
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
      : `<div class="measurement-display-label">${htmlText('visualisation')}</div>`}
  </div>` : '';
  const last = rows[0];
  const emptyText = profile ? t('noWeighInsForProfile') : t('chooseProfileToViewWeighIns');
  const summary = last ? `<div class="panel measurement-summary">
    <p>${htmlText('latestWeight')} <strong>${weight(last.measures)}</strong></p><p class="muted">${formatDateMinutes(last.receivedAt)}</p>
  </div>` : '';
  header ??= pageHeader(t('weighIns'));
  if (!last) return { header, content: `${settings}<p class="panel empty">${e(emptyText)}</p>` };
  if (chart) {
    const series = [
      { id: 'weight', label: t('weightKg'), read: kg },
      { id: 'impedanceOhms', label: t('impedanceOhms'), read: row => row.measures?.impedanceOhms ?? row.impedanceOhms },
      ...METRICS.map(([id, label]) => ({ id, label, read: row => averageValue(row, id, sourcesByMetric.get(id)) })),
    ];
    return { header, content: `${summary}${settings}${measurementCharts(rows, series, { ...chartOptions, profileAge: profile?.age })}` };
  }

  const extraColumns = [
    { id: 'date', label: t('date'), cells: row => `<td${columnDrag('date')} class="numeric"><button class="reading-date" type="button" aria-label="${htmlText('openWeighIn', [formatDate(row.receivedAt)])}">${formatDate(row.receivedAt)}</button></td>` },
    { id: 'weight', label: t('weight'), cells: row => `<td${columnDrag('weight')} class="numeric"><strong>${weight(row.measures)}</strong></td>` },
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
    <div class="panel table-scroll pinned-header" tabindex="0" role="region" aria-label="${htmlText('weighIns')}">
      <table class="measurements-table" aria-label="${htmlText('weighIns')}"${defaultOrder(measurementColumnOrder)}>
        <thead><tr>${headers}</tr>
        ${twoRows ? `<tr>${ordered.map(({ id, separate, subheaders }) => separate
          ? `<th scope="col"${columnDrag(id)}>${htmlText('average')}</th>${subheaders.join('')}` : '').join('')}</tr>` : ''}</thead>
        <tbody>${rows.map((row, index) => `<tr data-action="reading" data-value="${index}">
          ${ordered.map(({ cells }) => cells(row)).join('')}
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  return { header, content };
}

export function measurementDetails(row, methodOrder = [], sectionOrder = [], sectionsOpen = {}, header, formatReadingDate = formatDateMinutes) {
  const byId = new Map(methods.map(method => [method.id, method]));
  const activeMethods = [...new Set([...methodOrder, ...byId.keys()])].map(id => byId.get(id))
    .filter(Boolean).filter(({ id }) => METRICS.some(([metric]) => Number.isFinite(row.calculations?.[id]?.[metric])))
    .map(method => ({
      ...method,
      source: method.id === 'Owe' && row.profile?.sex === 'H'
        ? 'https://doi.org/10.1093/ajcn/46.6.875' : methodSources[method.id],
    }));
  const measures = row.measures ?? row;
  const readings = `<p><strong>${weight(measures)}</strong> · ${formatReadingDate(row.receivedAt)}</p>`;
  const comparison = activeMethods.length ? `<div class="panel table-scroll pinned-header comparison-scroll" role="region" aria-label="${htmlText('comparisonOfMethods')}" tabindex="0">
    <table aria-label="${htmlText('comparisonOfMethods')}"${defaultOrder(methodColumnOrder)}><thead><tr><th scope="col">${htmlText('measurementField')}</th><th scope="col">${htmlText('average')}</th>${activeMethods.map(method => methodHeader(method, columnDrag(method.id))).join('')}</tr></thead>
    <tbody>${METRICS.filter(([id]) => activeMethods.some(method => Number.isFinite(row.calculations?.[method.id]?.[id])))
      .map(([id, label, precision]) => `<tr><th scope="row">${e(label)}</th><td class="numeric">${number(averageValue(row, id, activeMethods), precision)}</td>${activeMethods.map(method => methodValue(row, id, method, precision, columnDrag(method.id))).join('')}</tr>`).join('')}</tbody></table></div>` : '';
  const legend = activeMethods.length ? `<div class="legend">${activeMethods.map(({ icon, id, label, style, source }) => `<span style="${style}">${sourceLink(source, `${icon} ${e(methodName(id))} · ${e(label)}`)}</span>`).join('')}</div>
    <p class="muted">${htmlText('methodsMarkedWithAnAsteriskUse')}</p>` : '';
  const sections = [
    ['methods', t('calculationMethods'), legend, false],
    ['measures', t('measurements'), pairs([
      [t('weight'), number(measures.weight)],
      [t('unit'), measures.unit],
      [t('impedanceOhms'), number(measures.impedanceOhms)],
    ]), false],
    ['profile', t('profileAtWeighIn'), row.profile && pairs([
      [t('name'), row.profile.name ?? t('temporaryProfile')],
      [t('sexUsed'), sexLabel(row.profile.sex)],
      [t('ageAtWeighIn'), number(row.profile.ageAtWeighIn ?? row.profile.age)],
      [t('heightUsedCm'), number(row.profile.heightCm)],
      [t('profileDateOfBirth'), formatCalendarDate(row.profile.birthDate)],
    ]), true],
    ['reception', t('receptionDetails'), row.reception && pairs(extras.slice(3, 11).map(([, label, read]) => [label, textValue(read(row))])), true],
    ['device', t('scaleAtWeighIn'), row.device && pairs([[t('name'), row.device.name], ...deviceFields(row.device)]), false],
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
  return { header: header ?? pageHeader(t('weighInDetails')), content };
}
