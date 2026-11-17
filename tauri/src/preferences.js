import { invoke, isTauri } from '@tauri-apps/api/core';
import { requestWebSession } from './web-session.js';

export const snapshotKey = 'epi-session-v1';

export async function loadLanguagePreference() {
  if (isTauri()) {
    const context = await invoke('get_dataset_context');
    if (context.locked) return undefined;
    return invoke('load_language_preference', { datasetId: context.datasetId, datasetGeneration: context.datasetGeneration });
  }
  if (import.meta.env.MODE === 'hosted') return undefined;
  if (import.meta.env.MODE === 'web') {
    const response = await fetch('/api/installation', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'context', args: [] }) });
    if (!response.ok) return undefined;
    const context = await response.json();
    if (context.locked) return undefined;
    const { state } = await requestWebSession('loadLanguagePreference', [], undefined, context.datasetId, context.datasetGeneration);
    return state.languagePreference;
  }
  return JSON.parse(localStorage.getItem(snapshotKey))?.languagePreference;
}
