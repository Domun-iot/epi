import { locale, t, htmlText } from './i18n.js';
import { escapeHtml as e, formatDate } from './format.js';

const axisDay = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
const axisMonth = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' });
const axisEdgeDay = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' });
const axisYear = new Intl.DateTimeFormat(locale, { year: 'numeric' });
const axisValue = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
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
  const pixelsPerDay = width / (localDay(end) - localDay(start) + 1);
  const unit = pixelsPerDay >= 12 ? 'day' : pixelsPerDay * 7 >= 12 ? 'week' : 'month';
  const lastDay = periodStart(end, 'day').getTime();
  const position = time => width * (time - start) / (end - start);
  const edgeLabel = time => [axisEdgeDay.format(time), axisYear.format(time)].join('\n');
  const dates = [];
  const date = periodStart(start, unit);
  advancePeriod(date, unit);
  for (; date < lastDay; advancePeriod(date, unit)) dates.push(date.getTime());

  // Use one calendar grid and promote every Nth tick based on the tightest spacing.
  const spacing = dates.reduce((gap, time, index) => index
    ? Math.min(gap, position(time) - position(dates[index - 1])) : gap, Infinity);
  const stride = Math.max(1, Math.ceil(48 / spacing));
  const edgeGap = 60;
  const firstMajor = dates.findIndex(time => position(time) >= edgeGap);
  const format = unit === 'month' ? axisMonth : axisDay;
  const ticks = [[start, edgeLabel(start)], ...dates.map((time, index) => {
    const label = firstMajor >= 0 && index >= firstMajor && (index - firstMajor) % stride === 0
      && width - position(time) >= edgeGap;
    return [time, label ? format.formatToParts(time).filter(part => part.type !== 'literal')
      .map(part => part.value).join('\n') : ''];
  }), [end, edgeLabel(end)]];
  axis.innerHTML = ticks.map(([time, label]) => {
    const edge = time === start ? ' chart-date-start' : time === end ? ' chart-date-end' : '';
    const major = label ? ' chart-date-major' : '';
    return `<div class="chart-date-tick${major}${edge}" data-time="${time}" style="--x:${position(time)}px">${label ? `<span>${e(label)}</span>` : ''}</div>`;
  }).join('');
}

function rangeDuration([start, end]) {
  const days = localDay(end) - localDay(start) + 1;
  const [unit, divisor] = days > 365 ? ['year', 365] : days > 30 ? ['month', 30] : ['day', 1];
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 1,
  }).format(days / divisor);
}

function valueScale(points) {
  let low = 0;
  let high = 0;
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
  { upper: 16, label: t('severeThinness'), color: '#d54848' },
  { upper: 17, label: t('moderateThinness'), color: '#e67e32' },
  { upper: 18.5, label: t('mildThinness'), color: '#e5b72c' },
  { upper: 25, label: t('normalWeight'), color: '#44a66b' },
  { upper: 30, label: t('overweight'), color: '#e5b72c' },
  { upper: 35, label: t('obesityI'), color: '#e67e32' },
  { upper: 40, label: t('obesityIi'), color: '#d54848' },
  { upper: Infinity, label: t('obesityIii'), color: '#9b61cb' },
];

function bmiScale(points) {
  let low = Infinity;
  let high = -Infinity;
  for (const { value, plottedValue } of points) {
    low = Math.min(low, value, plottedValue);
    high = Math.max(high, value, plottedValue);
  }

  const finalBand = bmiBands.length - 1;
  let first = bmiBands.findIndex(({ upper }) => low < upper);
  let last = bmiBands.findIndex(({ upper }) => high < upper);
  if (first === last) {
    first = Math.max(0, first - 1);
    last = Math.min(finalBand, last + 1);
  } else {
    const lower = bmiBands[first - 1]?.upper;
    const upper = bmiBands[last].upper;
    if (first > 0 && low < (lower + bmiBands[first].upper) / 2) first--;
    if (last < finalBand && high > (bmiBands[last - 1].upper + upper) / 2) last++;
  }

  if (last - first < 2) {
    const distanceBelow = first > 0 ? low - bmiBands[first - 1].upper : Infinity;
    const distanceAbove = last < finalBand ? bmiBands[last].upper - high : Infinity;
    if (distanceBelow <= distanceAbove) first--;
    else last++;
  }

  const min = bmiBands[first - 1]?.upper ?? Math.min(15, Math.floor(low - .5));
  const max = last === finalBand ? Math.max(45, Math.ceil(high + .5)) : bmiBands[last].upper;
  const y = value => 100 * (max - value) / (max - min);
  const bands = bmiBands.slice(first, last + 1);
  const ticks = [min];
  const minTickGap = (max - min) * .08;
  for (const { upper } of bands) {
    if (upper - ticks.at(-1) >= minTickGap && max - upper >= minTickGap) ticks.push(upper);
  }
  ticks.push(max);
  return { min, max, y, ticks, bands };
}

function renderBmiBands({ y, min, max, bands }) {
  return bands.map(({ upper, color }, index) => {
    const top = y(Math.min(max, upper));
    const bottom = y(bands[index - 1]?.upper ?? min);
    return `<rect class="chart-bmi-band" x="0" y="${top}" width="100" height="${bottom - top}" fill="${color}"/>`;
  }).join('');
}

function renderBmiReference(value) {
  const category = bmiBands.find(({ upper }) => value < upper);
  return `<details class="chart-bmi-reference">
    <summary>${htmlText('adultBmiCategory', [category.label])}</summary>
    <ul>${bmiBands.map(({ upper, label, color }, index) => {
      const lower = bmiBands[index - 1]?.upper;
      const interval = lower === undefined ? `&lt; ${axisValue.format(upper)}`
        : upper === Infinity ? `≥ ${axisValue.format(lower)}`
          : htmlText('bmiInterval', { min: axisValue.format(lower), max: axisValue.format(upper) });
      return `<li><span aria-hidden="true" style="--band-color:${color}"></span>${e(label)} (${interval})</li>`;
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
const periods = [['30', t('chartThirtyDays')], ['90', t('chartNinetyDays')], ['365', t('chartOneYear')], ['all', t('chartAllTime')]];
const signedValue = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, signDisplay: 'exceptZero' });

const statusLabels = { visible: t('visible'), bold: t('inBold'), hidden: t('hiddenSeries') };

export function measurementCharts(rows, series, { period = 'all', range, lastRange, mode = 'smooth', statuses = {}, profileAge }) {
  const configured = series.map((item, index) => ({ ...item, color: colors[index] }))
    .filter(({ id }) => Object.hasOwn(statuses, id));
  const timeline = rows.map((row, index) => ({ row, index, time: Date.parse(row.receivedAt) }))
    .filter(({ time }) => Number.isFinite(time)).sort((a, b) => a.time - b.time);
  const latestTime = timeline.at(-1)?.time;
  const cutoff = period === 'all' ? -Infinity : latestTime - Number(period) * dayMs;
  const [firstTime, lastTime] = range ?? [timeline.find(({ time }) => time >= cutoff)?.time, latestTime];
  const start = new Date(firstTime).setHours(0, 0, 0, 0);
  const end = new Date(lastTime).setHours(23, 59, 59, 999);
  const visible = configured.filter(({ id }) => statuses[id] !== 'hidden');
  const lines = visible.map(item => plotSeries(item, timeline, start, end, mode)).filter(Boolean);
  const active = lines.find(({ id }) => statuses[id] === 'bold') ?? lines[0];
  const subtitle = active?.points.length > 1 ? chartChange(active) : '';
  const legend = `<div class="chart-legend" role="group" aria-labelledby="chart-series-label">
    <span id="chart-series-label">${htmlText('chartSeries')}</span>
    ${configured.map(({ id, label, color }) => `<button type="button" data-action="chart-axis" data-value="${id}"
      data-status="${statuses[id]}" aria-pressed="${statuses[id] === 'bold'}" aria-description="${e(statusLabels[statuses[id]])}"
      style="--series-color:${color}">${e(label)}</button>`).join('')}
  </div>`;
  return `<section class="panel measurement-chart" aria-labelledby="measurement-chart-title">
    <div class="chart-heading">
      <div>
        <h2 id="measurement-chart-title">${htmlText('weighInTrends')}</h2>
        ${subtitle}
      </div>
      <div class="chart-controls">
        <div class="chart-periods" role="group" aria-label="${htmlText('chartDisplayMode')}">
          <button type="button" data-action="chart-mode" data-value="raw" aria-pressed="${mode === 'raw'}">${htmlText('raw')}</button>
          <button type="button" data-action="chart-mode" data-value="smooth" aria-pressed="${mode === 'smooth'}"
            title="${htmlText('sevenDayCentredAverage')}">${htmlText('trend')}</button>
        </div>
        <div class="chart-periods" role="group" aria-label="${htmlText('period')}">
          ${lastRange ? `<button type="button" data-action="chart-period" data-value="custom"
            aria-pressed="${Boolean(range)}" title="${htmlText('lastCustomDateRange')}">${e(rangeDuration(lastRange))}</button>` : ''}
          ${periods.map(([id, label]) => `<button type="button" data-action="chart-period" data-value="${id}"
            aria-pressed="${!range && period === id}">${e(label)}</button>`).join('')}
        </div>
        <button type="button" class="button icon-button" data-action="chart-fullscreen"
          aria-label="${htmlText('fullScreen')}" aria-pressed="false" title="${htmlText('fullScreen')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path class="chart-expand" d="M9 3H3v6m12-6h6v6m0 6v6h-6M3 15v6h6"/>
            <path class="chart-collapse" d="M3 9h6V3m6 0v6h6m0 6h-6v6m-6 0v-6H3"/>
          </svg>
        </button>
      </div>
    </div>
    ${legend}
    ${active ? chartPlot(lines, active, { start, end, statuses, profileAge })
      : `<p class="empty">${visible.length ? htmlText('emptyChart') : htmlText('allSeriesHidden')}</p>`}
  </section>`;
}

function chartChange({ id, label, points }) {
  const change = signedValue.format(points.at(-1).value - points[0].value);
  const message = id === 'weight' ? htmlText('weightChange', { delta: change + ' kg' })
    : htmlText('seriesChange', { series: label, delta: change });
  return `<p class="chart-change">${message}</p>`;
}

function chartPlot(lines, active, { start, end, statuses, profileAge }) {
  const bmiReference = active.id === 'bmi' && active.points.every(({ row }) => {
    const age = row.profile?.age ?? profileAge;
    return age == null || age >= 18;
  });
  if (bmiReference) Object.assign(active, bmiScale(active.points));
  const layered = [...lines.filter(line => line !== active), active];
  const x = time => end === start ? 50 : 100 * (time - start) / (end - start);
  const latest = active.points.at(-1);
  return `<div class="chart-frame">
      <div class="chart-values" aria-hidden="true">${active.ticks.map(value =>
        `<span style="--y:${active.y(value)}%">${axisValue.format(value)}</span>`).join('')}</div>
      <div class="chart-plot"${start < end ? ` data-start="${start}" data-end="${end}"
        title="${htmlText('dragToSelectDateRange')}"` : ''}>
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
