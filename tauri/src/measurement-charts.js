import { escapeHtml as e, formatDate } from './format.js';

const axisDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });
const axisDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const axisMonth = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const axisValue = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const dayMs = 86400_000;

function localDay(time) {
  return Math.floor((time - new Date(time).getTimezoneOffset() * 60_000) / dayMs);
}

function timeUnit(start, end) {
  const days = localDay(end) - localDay(start);
  if (days > 30) return 'month';
  if (days > 7) return 'week';
  return 'day';
}

function periodStart(time, unit) {
  const date = new Date(time);
  if (unit === 'month') date.setDate(1);
  if (unit === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  date.setHours(0, 0, 0, 0);
  return date;
}

function advancePeriod(date, unit, count = 1) {
  if (unit === 'month') date.setMonth(date.getMonth() + count);
  else date.setDate(date.getDate() + count * (unit === 'week' ? 7 : 1));
  date.setHours(0, 0, 0, 0);
}

export function snapChartRange(start, end) {
  const unit = timeUnit(start, end);
  const left = periodStart(start, unit);
  if (unit === 'day') advancePeriod(left, unit, -1);
  const right = periodStart(end, unit);
  advancePeriod(right, unit);
  return [left.getTime(), right.getTime() - 1];
}

export function renderChartDates(axis, width) {
  if (width <= 0) return;
  const start = Number(axis.dataset.start);
  const end = Number(axis.dataset.end);
  const unit = timeUnit(start, end);
  const date = periodStart(start, unit);
  if (date < start) advancePeriod(date, unit);
  const format = unit === 'month' ? axisMonth : axisDay;
  const labelGap = 80;
  const labelInset = Math.min(35, width / 2);
  const labels = [];
  let previous = -Infinity;
  // Clip the label centers at the edges, and omit labels whose text would overlap.
  for (; date <= end; advancePeriod(date, unit)) {
    const position = end === start ? width / 2 : width * (date - start) / (end - start);
    const center = Math.max(labelInset, Math.min(width - labelInset, position));
    if (center - previous < labelGap) continue;
    labels.push(`<div class="chart-date-tick" data-time="${date.getTime()}" style="--x:${position}px;--label-offset:${center - position}px">
      <span>${e(format.format(date))}</span>
    </div>`);
    previous = center;
  }
  axis.innerHTML = labels.join('') || `<div class="chart-date-tick" style="--x:50%"><span>${e(axisDate.format(start))}</span></div>`;
}

function rangeLabel([start, end]) {
  const days = localDay(end) - localDay(start) + 1;
  const [unit, divisor] = days > 365 ? ['year', 365] : days > 30 ? ['month', 30] : ['day', 1];
  const duration = new Intl.NumberFormat('fr-FR', {
    style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 1,
  }).format(days / divisor);
  return `Du ${axisDate.format(start)} au ${axisDate.format(end)} (${duration})`;
}

function valueScale(points, referenceTop = 0) {
  let low = 0;
  let high = referenceTop;
  for (const { value, plottedValue } of points) {
    low = Math.min(low, value, plottedValue);
    high = Math.max(high, value, plottedValue);
  }
  const range = Math.max((high - low) * 1.05, .4);
  const magnitude = 10 ** Math.floor(Math.log10(range / 4));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(value => value >= range / 4);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil((low + range) / step) * step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step);
  const y = value => 100 * (max - value) / (max - min);
  return { min, max, ticks, y };
}

const bmiBands = [
  { upper: 16, label: 'Maigreur sévère', color: '#d54848' },
  { upper: 17, label: 'Maigreur modérée', color: '#e67e32' },
  { upper: 18.5, label: 'Maigreur légère', color: '#e5b72c' },
  { upper: 25, label: 'Corpulence normale', color: '#44a66b' },
  { upper: 30, label: 'Surpoids', color: '#e5b72c' },
  { upper: 35, label: 'Obésité I', color: '#e67e32' },
  { upper: 40, label: 'Obésité II', color: '#d54848' },
  { upper: Infinity, label: 'Obésité III', color: '#9b61cb' },
];

function renderBmiBands({ y, min, max }) {
  return bmiBands.map(({ upper, color }, index) => {
    const top = y(Math.min(max, upper));
    const bottom = y(Math.max(min, bmiBands[index - 1]?.upper ?? min));
    return `<rect class="chart-bmi-band" x="0" y="${top}" width="100" height="${bottom - top}" fill="${color}"/>`;
  }).join('');
}

function renderBmiReference(value) {
  const category = bmiBands.find(({ upper }) => value < upper);
  return `<details class="chart-bmi-reference">
    <summary>Repères IMC adulte · ${category.label}</summary>
    <ul>${bmiBands.map(({ upper, label, color }, index) => {
      const lower = bmiBands[index - 1]?.upper;
      const interval = lower === undefined ? `&lt; ${axisValue.format(upper)}`
        : upper === Infinity ? `≥ ${axisValue.format(lower)}`
          : `${axisValue.format(lower)} à &lt; ${axisValue.format(upper)}`;
      return `<li><span aria-hidden="true" style="--band-color:${color}"></span>${label} (${interval})</li>`;
    }).join('')}</ul>
  </details>`;
}

function smoothSamples(samples) {
  const halfWindow = 3.5 * 86400_000;
  const points = samples.filter(({ value }) => Number.isFinite(value));
  let first = 0;
  let last = 0;
  let sum = 0;
  for (const point of points) {
    while (last < points.length && points[last].time <= point.time + halfWindow) sum += points[last++].value;
    while (points[first].time < point.time - halfWindow) sum -= points[first++].value;
    point.plottedValue = sum / (last - first);
  }
}

function plotSeries(series, timeline, start, end, mode) {
  const history = timeline.map(reading => {
    const value = series.read(reading.row);
    return { ...reading, value, plottedValue: value };
  });
  if (mode === 'smooth') smoothSamples(history);
  const samples = history.filter(({ time }) => time >= start && time <= end);
  const points = samples.filter(({ value }) => Number.isFinite(value));
  if (!points.length) return null;
  return { ...series, samples, points, ...valueScale(points) };
}

function renderLine({ id, color, samples, y }, x, active) {
  let connected = false;
  const path = samples.map(({ time, plottedValue }) => {
    if (!Number.isFinite(plottedValue)) {
      connected = false;
      return '';
    }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${x(time).toFixed(3)},${y(plottedValue).toFixed(3)}`;
  }).join(' ');
  return `<path class="chart-line${active ? ' chart-line-active' : ''}" data-series="${id}"
    style="--series-color:${color}" d="${path}" vector-effect="non-scaling-stroke"/>`;
}

function renderPoints({ id, label, color, points, y }, x, active) {
  return points.map(({ index, time, value, plottedValue }) => {
    const text = formatDate(time);
    const formatted = axisValue.format(value);
    const position = x(time);
    return `<button type="button" class="chart-point${active ? ' chart-point-active' : ''}" data-action="reading"
      data-series="${id}" data-value="${index}"
      style="--series-color:${color};--x:${position}%;--y:${y(plottedValue)}%;--tooltip-offset:${-position}%"
      aria-label="${e(label + ' · ' + text + ' · ' + formatted)}">
      <span class="chart-tooltip" aria-hidden="true"><strong>${e(label)} · ${formatted}</strong><span>${e(text)}</span></span>
    </button>`;
  }).join('');
}

const colors = [
  '#5279ee', '#d77a32', '#a369c9', '#2caa94', '#db547b', '#8c9e38', '#448fc1', '#b46e62',
  '#9087f4', '#b69143', '#428c58', '#bf518e', '#338f9d', '#bc6c46', '#806c9e', '#778a3a', '#b75959',
];
const periods = [['30', '30 j'], ['90', '90 j'], ['365', '1 an'], ['all', 'Tout']];
const signedValue = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, signDisplay: 'exceptZero' });

const statusLabels = { visible: 'Visible', bold: 'En gras', hidden: 'Masquée' };

export function measurementCharts(rows, series, { period = 'all', range, mode = 'smooth', statuses = {}, profileAge }) {
  const configured = series.map((item, index) => ({ ...item, color: colors[index] }))
    .filter(({ id }) => Object.hasOwn(statuses, id));
  const legend = `<div class="chart-legend" role="group" aria-labelledby="chart-series-label">
    <span id="chart-series-label">Courbes</span>
    ${configured.map(({ id, label, color }) => `<button type="button" data-action="chart-axis" data-value="${id}"
      data-status="${statuses[id]}" aria-pressed="${statuses[id] === 'bold'}" aria-description="${statusLabels[statuses[id]]}"
      style="--series-color:${color}">${e(label)}</button>`).join('')}
  </div>`;
  return `<section class="panel measurement-chart" aria-labelledby="measurement-chart-title">
    <div class="chart-heading">
      <h2 id="measurement-chart-title">Évolution des pesées</h2>
      <div class="chart-periods" role="group" aria-label="Lissage">
        <button type="button" data-action="chart-mode" data-value="raw" aria-pressed="${mode === 'raw'}">Brut</button>
        <button type="button" data-action="chart-mode" data-value="smooth" aria-pressed="${mode === 'smooth'}"
          title="Moyenne centrée sur sept jours">Adouci</button>
      </div>
      <div class="chart-periods" role="group" aria-label="Période">
        ${periods.map(([id, label]) => `<button type="button" data-action="chart-period" data-value="${id}"
          aria-pressed="${!range && period === id}">${label}</button>`).join('')}
      </div>
    </div>
    ${range ? `<p class="chart-range">${e(rangeLabel(range))}</p>` : ''}
    ${chartPlot(rows, configured, { period, range, mode, statuses, profileAge }, legend)}
  </section>`;
}

function chartPlot(rows, series, { period, range, mode, statuses, profileAge }, legend) {
  const timeline = rows.map((row, index) => ({ row, index, time: Date.parse(row.receivedAt) }))
    .filter(({ time }) => Number.isFinite(time)).sort((a, b) => a.time - b.time);
  const latestTime = timeline.at(-1)?.time;
  const cutoff = period === 'all' ? -Infinity : latestTime - Number(period) * dayMs;
  const [start, end] = range
    ? [new Date(range[0]).setHours(0, 0, 0, 0), new Date(range[1]).setHours(23, 59, 59, 999)]
    : [timeline.find(({ time }) => time >= cutoff)?.time, latestTime];
  const visible = series.filter(({ id }) => statuses[id] !== 'hidden');
  const lines = visible.map(item => plotSeries(item, timeline, start, end, mode)).filter(Boolean);
  if (!lines.length) {
    const message = visible.length ? 'Aucune donnée à afficher sur le graphique.' : 'Toutes les courbes sont masquées.';
    return `${legend}<p class="empty">${message}</p>`;
  }

  const active = lines.find(({ id }) => statuses[id] === 'bold') ?? lines[0];
  const bmiReference = active.id === 'bmi' && active.points.every(({ row }) => {
    const age = row.profile?.age ?? profileAge;
    return age == null || age >= 18;
  });
  if (bmiReference) Object.assign(active, valueScale(active.points, 45));
  const layered = [...lines.filter(line => line !== active), active];
  const x = time => end === start ? 50 : 100 * (time - start) / (end - start);
  const latest = active.points.at(-1);
  const change = latest.value - active.points[0].value;
  const changeLabel = active.points.length > 1
    ? `<span class="chart-change">${signedValue.format(change)} sur la période</span>` : '';
  return `<div class="chart-summary">
      <span>${e(active.label)}</span>
      <div><strong>${axisValue.format(latest.value)}</strong>${changeLabel}</div>
    </div>
    ${legend}
    <div class="chart-frame">
      <div class="chart-values" aria-hidden="true">${active.ticks.map(value =>
        `<span style="--y:${active.y(value)}%">${axisValue.format(value)}</span>`).join('')}</div>
      <div class="chart-plot"${start < end ? ` data-start="${start}" data-end="${end}"
        title="Glissez horizontalement pour sélectionner une plage de dates"` : ''}>
        <div class="chart-selection" hidden></div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          ${bmiReference ? renderBmiBands(active) : ''}
          ${active.ticks.map(value => `<path class="chart-gridline" d="M0,${active.y(value)} H100" vector-effect="non-scaling-stroke"/>`).join('')}
          ${layered.map(line => renderLine(line, x, statuses[line.id] === 'bold')).join('')}
        </svg>
        ${layered.map(line => renderPoints(line, x, statuses[line.id] === 'bold')).join('')}
      </div>
      <div class="chart-dates" data-start="${start}" data-end="${end}" aria-hidden="true"></div>
    </div>
    ${bmiReference ? renderBmiReference(latest.value) : ''}`;
}
