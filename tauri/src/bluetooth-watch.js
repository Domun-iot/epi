import bluetooth from 'virtual:epi-bluetooth';
import { button, escapeHtml, formatDate, formatScaleTime, pageHeader, weight } from './format.js';

const logKey = 'epi-bluetooth-log-v1';
const retentionMs = 24 * 60 * 60 * 1000;
const maxRawBytes = 32;

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

function frameText(frame) {
  const source = [frame.localName, frame.model].filter(Boolean).join(' ');
  const fields = [frame.address, source, frame.label, frame.advertisementType === 'Gatt' ? 'GATT' : '',
    frame.rssi == null ? '' : `${frame.rssi} dBm`,
    `${frame.bytes} octet${frame.bytes === 1 ? ' reçu' : 's reçus'}`];
  if (Number.isFinite(frame.weight)) {
    fields.push(weight(frame), frame.removed ? 'Balance libérée' : frame.stable ? 'Poids stable' : 'Poids instable',
      frame.impedanceOhms ? `${frame.impedanceOhms} Ω` : '', frame.scaleTime ? formatScaleTime(frame.scaleTime) : '');
  } else if (frame.bytes <= maxRawBytes && frame.hex) {
    fields.push(frame.hex.match(/../g).join(' ').toUpperCase());
  }
  return fields.filter(Boolean).join(' · ');
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
      row.textContent = `[${formatDate(frame.at)}] ${frame.text}`;
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
      frames.push({ at: Date.now(), address: frame.address, text: frameText(frame) });
      saveTimer ??= setTimeout(flush, 1000);
      repaint ??= requestAnimationFrame(paint);
    },
  };
}
