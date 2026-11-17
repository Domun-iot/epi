import { actions } from '../../web/actions.js';

export async function requestWebSession(action, args = [], token, datasetId, datasetGeneration) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: JSON.stringify({ action, args, datasetId, datasetGeneration }),
  });
  const state = await response.json();
  if (!response.ok) {
    if (response.status === 401 && token) window.dispatchEvent(new CustomEvent('epi:session-expired', { detail: { token } }));
    throw Object.assign(new Error(state.error), { code: state.error, status: response.status });
  }
  return { state, transactionsPending: response.headers.get('X-Epi-Transactions') === 'pending' };
}

export function createWebSession(onState, onTransactions, getToken, getDatasetId = () => undefined, isCurrent = () => true, getDatasetGeneration = () => undefined) {
  let pending = Promise.resolve();
  return Object.fromEntries([...actions, 'refreshView', 'exportFiles', 'importFiles', 'pendingTransactions', 'archiveTransactions', 'integrateTransactions'].map(action => [action, (...args) => {
    const token = getToken();
    const datasetId = getDatasetId();
    const datasetGeneration = getDatasetGeneration();
    const task = pending.then(async () => {
      if (!isCurrent()) throw new Error('dataset_changed');
      const { state, transactionsPending } = await requestWebSession(action, args, token, datasetId, datasetGeneration);
      if (!isCurrent()) throw new Error('dataset_changed');
      if (transactionsPending) onTransactions();
      if (action === 'pendingTransactions' || action === 'archiveTransactions') return state;
      if (action === 'integrateTransactions') {
        if (state.state) onState(state.state, { source: 'sync' });
        return state.uuids;
      }
      if (action === 'exportFiles') return state.files;
      if (action === 'importFiles') {
        onState(state.state);
        return state.added;
      }
      onState(state, action === 'reload' ? args[0] : undefined);
      return state;
    });
    pending = task.catch(() => {});
    return task;
  }]));
}
