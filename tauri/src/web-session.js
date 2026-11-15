import { actions } from '../../web/actions.js';

export function createWebSession(onState) {
  let pending = Promise.resolve();
  return Object.fromEntries(actions.map(action => [action, (...args) => {
    const task = pending.then(async () => {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args }),
      });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error);
      onState(state);
      return state;
    });
    pending = task.catch(() => {});
    return task;
  }]));
}
