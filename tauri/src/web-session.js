import { actions } from '../../web/actions.js';

export async function requestWebSession(action, args = [], token) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: JSON.stringify({ action, args }),
  });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error);
  return { state, transactionsPending: response.headers.get('X-Epi-Transactions') === 'pending' };
}

export function createWebSession(onState, onTransactions, getToken) {
  let pending = Promise.resolve();
  return Object.fromEntries([...actions, 'refreshView', 'exportFiles', 'importFiles', 'pendingTransactions', 'archiveTransactions', 'integrateTransactions'].map(action => [action, (...args) => {
    const task = pending.then(async () => {
      const { state, transactionsPending } = await requestWebSession(action, args, getToken());
      if (transactionsPending) onTransactions();
      if (action === 'pendingTransactions' || action === 'archiveTransactions') return state;
      if (action === 'integrateTransactions') {
        if (state.state) onState(state.state);
        return state.uuids;
      }
      if (action === 'exportFiles') return state.files;
      if (action === 'importFiles') {
        onState(state.state);
        return state.added;
      }
      onState(state);
      return state;
    });
    pending = task.catch(() => {});
    return task;
  }]));
}
