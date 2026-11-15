import { locale, t, htmlText } from './i18n.js';
import { bluetooth } from 'virtual:epi-domain';
import { button, escapeHtml, formatDate, formatScaleTime, number, pageHeader, weight } from './format.js';

const logKey = 'epi-bluetooth-log-v1';
const retentionMs = 24 * 60 * 60 * 1000;

function recentFrames(frames) {
  const cutoff = Date.now() - retentionMs;
  return frames.filter(frame => frame.at >= cutoff);
}

function readFrames() {
  try {
    const frames = JSON.parse(localStorage.getItem(logKey) ?? '[]');
    return Array.isArray(frames) ? recentFrames(frames.filter(frame =>
      Number.isFinite(frame?.at) && typeof frame.address === 'string' && (typeof frame.text === 'string' || typeof frame.decoded?.label === 'string'))) : [];
  } catch {
    return [];
  }
}

function saveFrames(frames) {
  let recent = recentFrames(frames);
  for (;;) {
    try {
      if (recent.length) localStorage.setItem(logKey, JSON.stringify(recent));
      else localStorage.removeItem(logKey);
      return;
    } catch (error) {
      if (error.name !== 'QuotaExceededError' || recent.length === 0) return;
      recent = recent.slice(Math.ceil(recent.length / 4));
    }
  }
}

export function bluetoothView({ addressFilter, devices }, web) {
  if (web) return {
    header: pageHeader(t('bluetoothMonitor')),
    content: `<p class="panel empty">${htmlText('bluetoothMonitorUnavailableOnWeb')}</p>`,
  };
  const device = devices.find(item => item.bluetooth.address === addressFilter);
  const target = device ? `${device.name} (${addressFilter})` : addressFilter;
  const filter = target ? t('monitoringDevice', [target]) : t('monitoringAllDevices');
  const controls = button(t('filterByBluetoothAddress'), 'filter-custom')
    + (target ? button(t('listenToAllDevices'), 'clear-filter') : '');
  return {
    header: pageHeader(t('bluetoothMonitor'), '', controls),
    content: `<p class="muted">${escapeHtml(filter)}</p>
      <div id="bluetooth-log" class="panel" role="region" aria-label="${htmlText('bluetoothFramesReceived')}" tabindex="0"></div>`,
  };
}

const bytePlural = new Intl.PluralRules(locale);

function formatFrame(frame) {
  const source = [frame.localName, frame.model].filter(Boolean).join(' ');
  const announcement = frame.label.startsWith('Service annoncé · ');
  const service = announcement ? frame.label.slice('Service annoncé · '.length) : frame.label;
  const label = service === 'Fabricant ' + frame.code ? t('unknownManufacturer', { code: frame.code })
    : service === 'Service ' + frame.code ? t('unknownService', { code: frame.code }) : service;
  const displayedLabel = announcement ? t('announcementService', { service: label }) : label;
  const fields = [frame.address, source, frame.macManufacturer, displayedLabel].filter(Boolean);
  const highlights = [];
  if (frame.prefixStatus) highlights.push([0, 8, frame.prefixStatus]);
  if (frame.codeStatus) {
    const labelStart = fields.join(' · ').length - displayedLabel.length;
    const start = labelStart + displayedLabel.lastIndexOf(frame.code);
    highlights.push([start, start + frame.code.length, frame.codeStatus]);
  }
  fields.push(frame.advertisementType === 'Gatt' ? 'GATT' : '',
    frame.rssi == null ? '' : `${frame.rssi} dBm`,
    t(bytePlural.select(frame.bytes) === 'one' ? 'bytesReceivedOne' : 'bytesReceivedOther', { count: number(frame.bytes) }));
  let text = fields.filter(Boolean).join(' · ');
  if (Number.isFinite(frame.weight)) {
    text += ' · ';
    const weightStart = text.length;
    text += weight(frame);
    highlights.push([weightStart, text.length, 'decoded']);
    const state = frame.removed ? t('scaleUnloaded') : frame.stable ? t('stableWeight') : t('unstableWeight');
    text += ` · ${state}`;
    if (frame.impedanceOhms) {
      text += ' · ';
      const impedanceStart = text.length;
      text += `${frame.impedanceOhms} Ω`;
      highlights.push([impedanceStart, text.length, 'decoded']);
    }
    if (frame.scaleTime) text += ` · ${formatScaleTime(frame.scaleTime)}`;
  }

  const bytes = frame.hex?.match(/../g);
  if (bytes) {
    const ascii = bytes.map(hex => {
      const byte = Number.parseInt(hex, 16);
      return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·';
    }).join('');
    text += `\n${bytes.join(' ').toUpperCase()}\n${ascii}`;
  }
  return { text, ...(highlights.length && { highlights }) };
}

export function createBluetoothWatch() {
  const decode = bluetooth.createWatchDecoder();
  let frames = [];
  let output;
  let filter;
  let rendered = 0;
  let repaint;
  let saveTimer;

  function flush() {
    if (saveTimer == null) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    saveFrames(frames);
  }

  window.addEventListener('pagehide', flush);

  function paint() {
    repaint = undefined;
    if (!output?.isConnected || rendered === frames.length) return;
    const following = output.scrollHeight - output.clientHeight - output.scrollTop <= 1;
    const fragment = document.createDocumentFragment();
    for (let index = rendered; index < frames.length; index++) {
      const frame = frames[index];
      if (filter && frame.address !== filter) continue;
      const row = document.createElement('div');
      row.textContent = `[${formatDate(frame.at)}] `;
      const { text, highlights } = frame.decoded ? formatFrame(frame.decoded) : frame;
      let offset = 0;
      for (const range of Array.isArray(highlights) ? highlights : []) {
        if (!Array.isArray(range)) continue;
        const [start, end, status] = range;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end <= start
            || end > text.length || !['known', 'unknown', 'decoded'].includes(status)) continue;
        const highlight = document.createElement('span');
        highlight.className = status === 'decoded' ? 'bluetooth-decoded' : `bluetooth-id-${status}`;
        highlight.textContent = text.slice(start, end);
        row.append(text.slice(offset, start), highlight);
        offset = end;
      }
      row.append(text.slice(offset));
      fragment.append(row);
    }
    output.append(fragment);
    if (following) output.scrollTop = output.scrollHeight;
    rendered = frames.length;
  }

  return {
    attach(element, address) {
      if (element === output) return;
      if (element && !output) {
        frames = readFrames();
        saveFrames(frames);
      } else if (!element) {
        flush();
        frames = [];
      }
      if (repaint != null) cancelAnimationFrame(repaint);
      output = element;
      filter = address;
      rendered = 0;
      paint();
    },
    receive(line) {
      if (!output?.isConnected && !line.startsWith('META ')) return;
      const frame = decode(line);
      if (!frame || !output?.isConnected || (filter && frame.address !== filter)) return;
      frames.push({ at: Date.now(), address: frame.address, decoded: frame });
      saveTimer ??= setTimeout(flush, 1000);
      repaint ??= requestAnimationFrame(paint);
    },
  };
}
