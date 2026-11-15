import { bluetooth } from 'virtual:epi-domain';
import { button, escapeHtml, formatDate, formatScaleTime, pageHeader, weight } from './format.js';

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
      Number.isFinite(frame?.at) && typeof frame.address === 'string' && typeof frame.text === 'string')) : [];
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
    header: pageHeader('Écoute Bluetooth'),
    content: '<p class="panel empty">L’écoute Bluetooth est disponible uniquement avec l’application ou la version standalone.</p>',
  };
  const device = devices.find(item => item.bluetooth.address === addressFilter);
  const target = device ? `${device.name} (${addressFilter})` : addressFilter;
  const filter = target ? `Écoute limitée à ${escapeHtml(target)}.` : 'Écoute de tous les appareils.';
  const controls = button('Filtrer par adresse Bluetooth', 'filter-custom')
    + (target ? button('Écouter tous les appareils', 'clear-filter') : '');
  return {
    header: pageHeader('Écoute Bluetooth', '', controls),
    content: `<p class="muted">${filter}</p>
      <div id="bluetooth-log" class="panel" role="region" aria-label="Trames Bluetooth reçues" tabindex="0"></div>`,
  };
}

function formatFrame(frame) {
  const source = [frame.localName, frame.model].filter(Boolean).join(' ');
  const fields = [frame.address, source, frame.macManufacturer, frame.label].filter(Boolean);
  const highlights = [];
  if (frame.prefixStatus) highlights.push([0, 8, frame.prefixStatus]);
  if (frame.codeStatus) {
    const labelStart = fields.join(' · ').length - frame.label.length;
    const start = labelStart + frame.label.lastIndexOf(frame.code);
    highlights.push([start, start + frame.code.length, frame.codeStatus]);
  }
  fields.push(frame.advertisementType === 'Gatt' ? 'GATT' : '',
    frame.rssi == null ? '' : `${frame.rssi} dBm`,
    `${frame.bytes} octet${frame.bytes === 1 ? ' reçu' : 's reçus'}`);
  if (Number.isFinite(frame.weight)) {
    fields.push(weight(frame), frame.removed ? 'Balance libérée' : frame.stable ? 'Poids stable' : 'Poids instable',
      frame.impedanceOhms ? `${frame.impedanceOhms} Ω` : '', frame.scaleTime ? formatScaleTime(frame.scaleTime) : '');
  }

  let text = fields.filter(Boolean).join(' · ');
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
      let offset = 0;
      for (const range of Array.isArray(frame.highlights) ? frame.highlights : []) {
        if (!Array.isArray(range)) continue;
        const [start, end, status] = range;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end <= start
            || end > frame.text.length || (status !== 'known' && status !== 'unknown')) continue;
        const id = document.createElement('span');
        id.className = `bluetooth-id-${status}`;
        id.textContent = frame.text.slice(start, end);
        row.append(frame.text.slice(offset, start), id);
        offset = end;
      }
      row.append(frame.text.slice(offset));
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
      frames.push({ at: Date.now(), address: frame.address, ...formatFrame(frame) });
      saveTimer ??= setTimeout(flush, 1000);
      repaint ??= requestAnimationFrame(paint);
    },
  };
}
