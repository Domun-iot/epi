import { escapeHtml as e, formatDate } from './format.js';

const axisDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });
const axisTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const axisValue = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

function valueScale(points) {
  let low = Infinity;
  let high = -Infinity;
  for (const { value } of points) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const range = Math.max(high - low, Math.abs(high) * .02, .4);
  const middle = (high + low) / 2;
  const magnitude = 10 ** Math.floor(Math.log10(range / 4));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(value => value >= range / 4);
  const min = Math.floor((middle - range / 2) / step) * step;
  const max = Math.ceil((middle + range / 2) / step) * step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step);
  return { min, max, ticks };
}

function plotSeries(series, readings, color) {
  const samples = readings.map(reading => ({ ...reading, value: series.read(reading.row) }));
  const points = samples.filter(({ value }) => Number.isFinite(value));
  if (!points.length) return null;
  const { min, max, ticks } = valueScale(points);
  const y = value => 100 * (max - value) / (max - min);
  return { ...series, color, samples, points, ticks, y };
}

function renderLine({ id, color, samples, y }, x, active) {
  let connected = false;
  const path = samples.map(({ time, value }) => {
    if (!Number.isFinite(value)) {
      connected = false;
      return '';
    }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${x(time).toFixed(3)},${y(value).toFixed(3)}`;
  }).join(' ');
  return `<path class="chart-line${active ? ' chart-line-active' : ''}" data-series="${id}"
    style="--series-color:${color}" d="${path}" vector-effect="non-scaling-stroke"/>`;
}

function renderPoints({ id, label, color, points, y }, x, active) {
  return points.map(({ index, time, value }) => {
    const text = formatDate(time);
    const formatted = axisValue.format(value);
    const position = x(time);
    return `<button type="button" class="chart-point${active ? ' chart-point-active' : ''}" data-action="reading"
      data-series="${id}" data-value="${index}"
      style="--series-color:${color};--x:${position}%;--y:${y(value)}%;--tooltip-offset:${-position}%"
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

export function measurementCharts(rows, series, { period, axis, selected }) {
  const timeline = rows.map((row, index) => ({ row, index, time: Date.parse(row.receivedAt) }))
    .filter(({ time }) => Number.isFinite(time)).sort((a, b) => a.time - b.time);
  const end = timeline.at(-1)?.time;
  const cutoff = period === 'all' ? -Infinity : end - Number(period) * 86400_000;
  const readings = timeline.filter(({ time }) => time >= cutoff);
  const lines = series.map((item, index) => item.id === 'weight' || selected.has(item.id)
    ? plotSeries(item, readings, colors[index]) : null).filter(Boolean);
  if (!lines.length) return '<p class="panel empty">Aucune donnée à afficher sur le graphique.</p>';

  const start = readings[0].time;
  const active = lines.find(({ id }) => id === axis) ?? lines[0];
  const layered = [...lines.filter(line => line !== active), active];
  const x = time => end === start ? 50 : 100 * (time - start) / (end - start);
  const dateLabel = axisDate.format(start) === axisDate.format(end) && start !== end ? axisTime : axisDate;
  const latest = active.points.at(-1);
  const change = latest.value - active.points[0].value;
  const changeLabel = active.points.length > 1
    ? `<span class="chart-change">${signedValue.format(change)} sur la période</span>` : '';
  return `<section class="panel measurement-chart" aria-labelledby="measurement-chart-title">
    <div class="chart-heading">
      <h2 id="measurement-chart-title">Évolution des pesées</h2>
      <div class="chart-periods" role="group" aria-label="Période">
        ${periods.map(([id, label]) => `<button type="button" data-action="chart-period" data-value="${id}"
          aria-pressed="${period === id}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="chart-summary">
      <span>${e(active.label)}</span>
      <div><strong>${axisValue.format(latest.value)}</strong>${changeLabel}</div>
    </div>
    <div class="chart-legend" role="group" aria-labelledby="chart-scale-label">
      <span id="chart-scale-label">Échelle verticale</span>
      ${lines.map(({ id, label, color }) => `<button type="button" data-action="chart-axis" data-value="${id}"
        aria-pressed="${id === active.id}" style="--series-color:${color}">${e(label)}</button>`).join('')}
    </div>
    <div class="chart-frame">
      <div class="chart-values" aria-hidden="true">${active.ticks.map(value =>
        `<span style="--y:${active.y(value)}%">${axisValue.format(value)}</span>`).join('')}</div>
      <div class="chart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          ${active.ticks.map(value => `<path class="chart-gridline" d="M0,${active.y(value)} H100" vector-effect="non-scaling-stroke"/>`).join('')}
          ${layered.map(line => renderLine(line, x, line === active)).join('')}
        </svg>
        ${layered.map(line => renderPoints(line, x, line === active)).join('')}
      </div>
      <div class="chart-dates" aria-hidden="true">${start === end
        ? `<span class="chart-date-single">${e(dateLabel.format(start))}</span>`
        : `<span>${e(dateLabel.format(start))}</span><span class="chart-date-middle">${e(dateLabel.format((start + end) / 2))}</span><span>${e(dateLabel.format(end))}</span>`}</div>
    </div>
  </section>`;
}
