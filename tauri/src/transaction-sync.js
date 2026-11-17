import { acknowledgeTransactions, checkAccountConnection, downloadTransactions, transactionSyncToken as syncToken, uploadTransactions } from './account.js';
import { formatDateMinutes } from './format.js';
import { t } from './i18n.js';

const retryDelay = 60_000;
const showDelay = 5_000;
const animationDuration = 15_000;
const maxTransactionBytes = 4 * 1024 * 1024 - '{"transactions":[],"next":""}'.length - 69;

const icon = document.querySelector('#sync-status');
const dialog = document.querySelector('#sync-dialog');
const message = document.querySelector('#sync-message');
const countdown = document.querySelector('#sync-countdown');
const syncNow = document.querySelector('#sync-now');

let files;
let running = false;
let uploading = false;
let queuedSync;
let oldest;
let waitingSince;
let statusTimer;
let countdownTimer;
let nextSyncAt;

function renderSyncDialog() {
  clearTimeout(countdownTimer);
  if (!dialog.open) return;

  const signedIn = Boolean(syncToken());
  syncNow.disabled = !signedIn || running;
  if (!signedIn) {
    countdown.textContent = t('syncSignInRequired');
  } else if (running) {
    countdown.textContent = t('syncInProgress');
  } else {
    const remaining = Math.max(0, nextSyncAt - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    countdown.textContent = t('syncCountdown', { time });
    if (remaining) countdownTimer = setTimeout(renderSyncDialog, remaining % 1000 || 1000);
  }
}

function renderStatus() {
  clearTimeout(statusTimer);
  const elapsed = Date.now() - waitingSince;
  icon.hidden = !syncToken() || !oldest || elapsed < showDelay;
  icon.classList.toggle('syncing', !icon.hidden && uploading && elapsed < showDelay + animationDuration);
  if (!syncToken() || !oldest) {
    if (dialog.open) dialog.close();
    return;
  }
  const stamp = oldest.slice(0, 27).replace(/T(\d\d)-(\d\d)-/, 'T$1:$2:');
  message.textContent = t('syncDelay', { date: formatDateMinutes(stamp) });
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

icon.addEventListener('click', () => {
  dialog.showModal();
  renderSyncDialog();
});
dialog.addEventListener('close', renderSyncDialog);
syncNow.addEventListener('click', requestFullTransactionSync);
for (const event of ['epi:account', 'epi:entitlement']) window.addEventListener(event, () => {
  requestTransactionSync();
  renderStatus();
  renderSyncDialog();
});

export function startTransactionSync(storage) {
  files = storage;
  function syncAccountAndTransactions() {
    nextSyncAt = Date.now() + retryDelay;
    setTimeout(syncAccountAndTransactions, retryDelay);
    const before = syncToken();
    void Promise.resolve(checkAccountConnection()).then(() => {
      if (syncToken() === before) requestTransactionSync();
    });
  }
  syncAccountAndTransactions();
}

export function requestTransactionSync() {
  requestSync('regular');
}

export function requestFullTransactionSync() {
  requestSync('full');
}

function requestSync(mode) {
  if (!files?.getSyncContext) return;
  if (running) {
    if (queuedSync !== 'full') queuedSync = mode;
    return;
  }
  void sync(mode).catch(() => {
    // Keep data queued when local storage is busy or initial reconciliation fails.
    renderStatus();
    renderSyncDialog();
  });
}

async function receive(context) {
  const { token } = context;
  let after;
  do {
    const { transactions, next } = await downloadTransactions(token, after);
    if (!context.isCurrent() || !Array.isArray(transactions)) return false;
    if (transactions.length) {
      transactions.sort((left, right) => {
        const a = typeof left?.name === 'string' ? left.name : '~';
        const b = typeof right?.name === 'string' ? right.name : '~';
        return a < b ? -1 : Number(a > b);
      });
      const uuids = await context.integrateTransactions(transactions);
      if (!context.isCurrent()) return false;
      if (uuids.length) await acknowledgeTransactions(token, uuids);
    }
    if (typeof next !== 'string') return true;
    if (next === after) return false;
    after = next;
  } while (context.isCurrent());
  return false;
}

async function receiveSafely(context) {
  if (!context.isCurrent()) return;
  try { await receive(context); }
  catch { /* Retry the same account-bound queue on the next pass. */ }
}

async function sendPending(context, manual = false) {
  const { token } = context;
  try {
    if (!context.isCurrent()) return;
    const pending = await context.pendingTransactions();
    if (!context.isCurrent()) return;
    updatePending(pending);
    if (!pending.length) { await context.clearRevision(); return true; }

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
    const result = await uploadTransactions(batch.map(({ line }) => line).join('\n') + '\n', token, context.revision);
    if (!context.isCurrent() || !Array.isArray(result?.uuids)) return;
    const confirmed = new Set(result.uuids);
    const names = batch.filter(({ uuid }) => confirmed.has(uuid)).map(({ name }) => name);
    if (!names.length) return true;
    await context.clearRevision();
    await context.archiveTransactions(names);
    if (context.isCurrent()) updatePending(await context.pendingTransactions());
    return true;
  } catch (error) {
    // Keep the original account queue intact after a conflict or interruption.
    if (error.code === 'dataset_changed' && context.isCurrent()) {
      window.dispatchEvent(new CustomEvent('epi:dataset-conflict', { detail: { accountId: context.datasetId, manual } }));
    }
  } finally {
    uploading = false;
    renderStatus();
  }
}

async function sync(mode) {
  running = true;
  renderSyncDialog();
  try {
    if (mode === 'full') {
      if (files.prepareSync) await files.prepareSync(true);
      else await checkAccountConnection();
    }
    const context = files.getSyncContext();
    if (!context) { updatePending([]); return; }
    // Initial attachment is conditional on the reviewed server revision.
    if (context.revision !== undefined) {
      const completed = await sendPending(context, mode === 'full');
      if (mode === 'full' && completed) await receiveSafely(context);
    }
    else if (mode === 'full') {
      await sendPending(context, true);
      await receiveSafely(context);
    } else {
      await receiveSafely(context);
      await sendPending(context);
    }
  } finally {
    running = false;
    if (queuedSync) {
      const next = queuedSync;
      queuedSync = undefined;
      requestSync(next);
    } else {
      renderSyncDialog();
    }
  }
}
