import { acknowledgeTransactions, checkAccountConnection, downloadTransactions, syncToken, uploadTransactions } from './account.js';
import { locale, t } from './i18n.js';

const retryDelay = 60_000;
const showDelay = 5_000;
const animationDuration = 15_000;
const maxTransactionBytes = 4 * 1024 * 1024 - '{"transactions":[],"next":""}'.length - 69;

const icon = document.querySelector('#sync-status');
const dialog = document.querySelector('#sync-dialog');
const message = document.querySelector('#sync-message');

let files;
let receivedForToken;
let running = false;
let uploading = false;
let requestedAgain = false;
let oldest;
let waitingSince;
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
window.addEventListener('epi:account', () => {
  receivedForToken = undefined;
  requestTransactionSync();
});

export function startTransactionSync(storage) {
  files = storage;
  function syncAccountAndTransactions() {
    void checkAccountConnection();
    requestTransactionSync();
  }
  syncAccountAndTransactions();
  setInterval(syncAccountAndTransactions, retryDelay);
}

export function requestTransactionSync() {
  if (!files?.pendingTransactions) return;
  if (running) {
    requestedAgain = true;
    return;
  }
  void sync();
}

async function receive(token) {
  let after;
  do {
    const { transactions, next } = await downloadTransactions(token, after);
    if (syncToken() !== token || !Array.isArray(transactions)) return false;
    if (transactions.length) {
      transactions.sort((left, right) => {
        const a = typeof left?.name === 'string' ? left.name : '~';
        const b = typeof right?.name === 'string' ? right.name : '~';
        return a < b ? -1 : Number(a > b);
      });
      const uuids = await files.integrateTransactions(transactions);
      if (syncToken() !== token) return false;
      if (uuids.length) await acknowledgeTransactions(token, uuids);
    }
    if (typeof next !== 'string') return true;
    if (next === after) return false;
    after = next;
  } while (syncToken() === token);
  return false;
}

async function sync() {
  running = true;
  try {
    const token = syncToken();
    if (token && receivedForToken !== token) {
      try {
        if (await receive(token)) receivedForToken = token;
      } catch {
        // Outgoing transactions can still be sent after a receive failure.
      }
    }
    const pending = await files.pendingTransactions();
    updatePending(pending);
    if (!token || token !== syncToken() || !pending.length) return;

    const encoder = new TextEncoder();
    const batch = [];
    for (const { name, transaction } of pending) {
      if (!transaction) continue;
      const line = JSON.stringify({ ...transaction, name });
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
    }
  }
}
