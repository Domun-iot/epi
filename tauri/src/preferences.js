import { invoke, isTauri } from '@tauri-apps/api/core';
import { requestWebSession } from './web-session.js';

export const snapshotKey = 'epi-session-v1';

export async function loadLanguagePreference() {
  if (isTauri()) return invoke('load_language_preference');
  if (import.meta.env.MODE === 'web') {
    const { state } = await requestWebSession('loadLanguagePreference');
    return state.languagePreference;
  }
  return JSON.parse(localStorage.getItem(snapshotKey))?.languagePreference;
}
