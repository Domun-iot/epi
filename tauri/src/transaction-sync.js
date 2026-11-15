import { syncToken, uploadTransactions } from './account.js';
import { locale, t } from './i18n.js';

const retryDelay = 60_000;
const showDelay = 5_000;
const animationDuration = 15_000;
// Leave room for the server's legacy JSON envelope in the per-transaction limit.
const maxTransactionBytes = 4 * 1024 * 1024 - '{"transactions":[]}'.length;

const icon = document.querySelector('#sync-status');
const dialog = document.querySelector('#sync-dialog');
const message = document.querySelector('#sync-message');

let files;
let running = false;
let uploading = false;
let requestedAgain = false;
let oldest;
let waitingSince;
let retryTimer;
let statusTimer;

function renderStatus() {
  clearTimeout(statusTimer);
  const elapsed = Date.now() - waitingSince;
  icon.hidden = !oldest || elapsed < showDelay;
  icon.classList.toggle('syncing', !icon.hidden && uploading && elapsed < showDelay + animationDuration);
  if (!oldest) {
    if (dialog.open) dialog.close();
    return;
  }
  const stamp = oldest.slice(0, 27).replace(/T(\d\d)-(\d\d)-/, 'T$1:$2:');
  const date = new Date(stamp);
  const formatted = Number.isNaN(date.getTime()) ? stamp : new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
  message.textContent = t('syncDelay', { date: formatted });
  icon.title = message.textContent;
  icon.setAttribute('aria-label', message.textContent);
  if (elapsed < showDelay) statusTimer = setTimeout(renderStatus, showDelay - elapsed);
  else if (uploading && elapsed < showDelay + animationDuration) {
    statusTimer = setTimeout(renderStatus, showDelay + animationDuration - elapsed);
  }
}

function updatePending(pending) {
  if (pending.length && !oldest) waitingSince = Date.now();
  oldest = pending[0]?.name;
  renderStatus();
}

icon.addEventListener('click', () => dialog.showModal());
window.addEventListener('epi:account', requestTransactionSync);

export function startTransactionSync(storage) {
  if (!storage.pendingTransactions) return;
  files = storage;
  requestTransactionSync();
}

export function requestTransactionSync() {
  if (!files) return;
  if (running) {
    requestedAgain = true;
    return;
  }
  clearTimeout(retryTimer);
  void sync();
}

async function sync() {
  running = true;
  const started = Date.now();
  try {
    const pending = await files.pendingTransactions();
    updatePending(pending);
    const token = syncToken();
    if (!token || !pending.length) return;

    const encoder = new TextEncoder();
    const batch = [];
    for (const { name, transaction } of pending) {
      if (!transaction) continue;
      const line = JSON.stringify(transaction);
      if (encoder.encode(line).length <= maxTransactionBytes) batch.push({ name, uuid: transaction.uuid, line });
    }
    if (!batch.length) return;
    uploading = true;
    renderStatus();
    const result = await uploadTransactions(batch.map(({ line }) => line).join('\n') + '\n', token);
    if (syncToken() !== token || !Array.isArray(result?.uuids)) return;
    const confirmed = new Set(result.uuids);
    const names = batch.filter(({ uuid }) => confirmed.has(uuid)).map(({ name }) => name);
    if (!names.length) return;
    await files.archiveTransactions(names);
    updatePending(await files.pendingTransactions());
  } catch {
    // Keep the files queued after network, server or local storage errors.
  } finally {
    running = uploading = false;
    renderStatus();
    if (requestedAgain) {
      requestedAgain = false;
      requestTransactionSync();
    } else {
      retryTimer = setTimeout(requestTransactionSync, Math.max(0, retryDelay - (Date.now() - started)));
    }
  }
}
