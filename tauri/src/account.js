import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

const productionApi = 'https://sync.epi.invalid';
const api = __DEV_ACCOUNT_API__ ?? productionApi;
const configured = !api.endsWith('.invalid');
const sessionKey = 'epi-account:' + api;
const deviceKey = 'epi-account-device';

const openButton = document.querySelector('#account-button');
const dialog = document.querySelector('#account-dialog');
const title = document.querySelector('#account-title');
const form = document.querySelector('#account-form');
const fields = document.querySelector('#account-fields');
const email = form.elements.email;
const password = form.elements.password;
const accountEmail = document.querySelector('#account-email');
const errorNotice = document.querySelector('#account-error');
const switchButton = document.querySelector('#account-switch');
const closeButton = document.querySelector('#account-close');
const submitButton = document.querySelector('#account-submit');

const googleButton = document.querySelector('#account-google');
const googleFields = document.querySelector('#account-google-fields');
const googlePasswordLabel = document.querySelector('#account-google-password-label');
const googlePassword = form.elements.googlePassword;
const googleConfirmField = document.querySelector('#account-google-confirm-field');
const googleConfirm = form.elements.googlePasswordConfirm;
const googleStatus = document.querySelector('#account-google-status');

let googleEnabled = false;
let accountInfo = null;
let managingGoogle = false;
let waitingForGoogle = false;
let cancelGoogle = false;
let account = null;
let creating = false;
let busy = false;

function readAccount() {
  const saved = JSON.parse(localStorage.getItem(sessionKey));
  return typeof saved?.email === 'string' && typeof saved.token === 'string' ? saved : null;
}

function getDeviceId() {
  const existing = localStorage.getItem(deviceKey);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(deviceKey, id);
  return id;
}

function showError(message) {
  errorNotice.hidden = !message;
  errorNotice.textContent = message;
}

function render() {
  title.textContent = account ? 'Compte' : creating ? 'Créer un compte' : 'Connexion';
  accountEmail.hidden = !account;
  accountEmail.textContent = account?.email ?? '';
  fields.hidden = Boolean(account);
  email.disabled = password.disabled = busy || Boolean(account);
  password.autocomplete = creating ? 'new-password' : 'current-password';
  switchButton.hidden = Boolean(account) || !configured;
  switchButton.disabled = busy;
  switchButton.textContent = creating ? 'Revenir à la connexion' : 'Créer un compte';
  const needsNewPassword = managingGoogle && !accountInfo?.hasPassword;
  googleFields.hidden = !managingGoogle;
  googlePasswordLabel.textContent = needsNewPassword ? 'Nouveau mot de passe' : 'Mot de passe actuel';
  googlePassword.autocomplete = needsNewPassword ? 'new-password' : 'current-password';
  googlePassword.disabled = busy || !managingGoogle;
  googleConfirmField.hidden = !needsNewPassword;
  googleConfirm.disabled = busy || !needsNewPassword;
  googleButton.hidden = account ? !accountInfo || (!googleEnabled && !(accountInfo.googleLinked && accountInfo.hasPassword)) : !googleEnabled;
  googleButton.disabled = busy;
  googleButton.textContent = !account ? (creating ? 'Créer le compte avec Google' : 'Se connecter avec Google')
    : accountInfo?.googleLinked ? 'Délier Google' : 'Associer Google';
  googleStatus.hidden = !waitingForGoogle;
  googleStatus.textContent = waitingForGoogle ? 'Termine la connexion Google dans le navigateur, puis reviens dans éPI.' : '';
  closeButton.disabled = busy && !waitingForGoogle;
  closeButton.textContent = waitingForGoogle || managingGoogle ? 'Annuler' : 'Fermer';
  submitButton.disabled = busy || !configured;
  submitButton.hidden = managingGoogle;
  submitButton.textContent = account ? 'Se déconnecter' : creating ? 'Créer le compte' : 'Se connecter';
  form.setAttribute('aria-busy', String(busy));
}

const errors = {
  account_exists: 'Un compte existe déjà pour cette adresse. Connecte-toi à ce compte pour y associer Google.',
  google_disabled: 'La connexion Google est désactivée sur ce serveur.',
  google_busy: 'Le serveur est occupé. Réessaie dans quelques minutes.',
  google_attempt_expired: 'La demande Google a expiré. Relance la connexion.',
  google_failed: 'La connexion Google a échoué ou a été annulée.',
  google_conflict: 'Cette association Google est déjà utilisée ou a changé. Rouvre les paramètres du compte.',
  google_wrong_account: 'Choisis le compte Google associé à ton compte éPI.',
  google_unverified_email: 'Google doit fournir une adresse e-mail vérifiée pour créer le compte.',
  google_not_linked: 'Ce compte Google n’est pas associé à éPI. Tu peux créer un compte ou l’associer depuis un compte existant.',
  invalid_token: 'Ta session a expiré. Reconnecte-toi.',
  token_expired: 'Ta session a expiré. Reconnecte-toi.',
  invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
  invalid_credentials_format: 'Vérifie l’adresse e-mail et le mot de passe.',
};

async function request(path, { method = 'POST', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(api + '/v1/' + path, {
      method,
      headers,
      body: body && JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    throw new Error('Le serveur de comptes est inaccessible.');
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 204) return;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(Object.hasOwn(errors, result?.error) ? errors[result.error] : 'Le serveur a renvoyé une erreur.');
    error.code = result?.error;
    throw error;
  }
  return result;
}

function saveSession(email, token) {
  if (typeof email !== 'string' || typeof token !== 'string' || !token) {
    throw new Error('Le serveur a renvoyé une session invalide.');
  }
  const session = { email, token };
  localStorage.setItem(sessionKey, JSON.stringify(session));
  account = session;
  form.reset();
}

async function refreshGoogle() {
  accountInfo = null;
  googleEnabled = false;
  if (!configured) return;
  const session = account;
  try {
    if (session) {
      const info = await request('account', { method: 'GET', token: session.token });
      if (session !== account) return;
      accountInfo = info;
      googleEnabled = info.googleAvailable;
    } else {
      const { enabled } = await request('google/config', { method: 'GET' });
      if (!account) googleEnabled = enabled === true;
    }
  } catch (error) {
    if (session === account && ['invalid_token', 'token_expired'].includes(error.code)) {
      localStorage.removeItem(sessionKey);
      account = null;
      showError(error.message);
      await refreshGoogle();
    }
  } finally {
    render();
  }
}

openButton.addEventListener('click', () => {
  creating = false;
  showError(configured ? '' : 'L’adresse du serveur de comptes reste à configurer.');
  try {
    account = readAccount();
  } catch {
    account = null;
    showError('La session enregistrée est inaccessible.');
  }
  render();
  dialog.showModal();
  void refreshGoogle();
});

function closeAccount() {
  if (waitingForGoogle) {
    cancelGoogle = true;
    return;
  }
  if (managingGoogle) {
    managingGoogle = false;
    form.reset();
    showError('');
    render();
    return;
  }
  if (!busy) dialog.close();
}

closeButton.addEventListener('click', closeAccount);
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeAccount();
});
dialog.addEventListener('close', () => form.reset());

switchButton.addEventListener('click', () => {
  creating = !creating;
  password.value = '';
  showError('');
  render();
  email.focus();
});

async function finishGoogle(action, body, popup, token) {
  const { state, secret, url } = await request('google/start', { body: { action, ...body }, token });
  const target = new URL(url);
  if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') {
    throw new Error('Le serveur a renvoyé une adresse Google invalide.');
  }
  if (cancelGoogle) return;
  if (popup) popup.location.href = target.href;
  else await openUrl(target.href);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (!cancelGoogle && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (cancelGoogle) return;
    const result = await request('google/finish', { body: { state, secret }, token });
    if (!result.pending) return result;
  }
  if (!cancelGoogle) throw new Error(errors.google_attempt_expired);
}

googleButton.addEventListener('click', async () => {
  if (busy || googleButton.hidden) return;
  if (account && !managingGoogle) {
    managingGoogle = true;
    showError('');
    render();
    googlePassword.focus();
    return;
  }

  const action = account ? (accountInfo.googleLinked ? 'unlink' : 'link') : (creating ? 'register' : 'login');
  const directUnlink = action === 'unlink' && accountInfo.hasPassword;
  const value = googlePassword.value;
  if (account && (!value || (action === 'unlink' && !directUnlink && value !== googleConfirm.value))) {
    showError(value ? 'Les deux mots de passe doivent être identiques.' : 'Saisis le mot de passe.');
    googlePassword.focus();
    return;
  }
  let popup;
  if (!directUnlink && !isTauri()) {
    popup = window.open('', '_blank');
    if (!popup) {
      showError('Autorise l’ouverture du nouvel onglet pour te connecter avec Google.');
      return;
    }
    popup.opener = null;
  }

  busy = true;
  cancelGoogle = false;
  waitingForGoogle = !directUnlink;
  showError('');
  render();
  try {
    const body = account ? { password: value } : { deviceId: getDeviceId() };
    const token = account?.token;
    const result = directUnlink
      ? await request('google/unlink', { body, token })
      : await finishGoogle(action, body, popup, token);
    if (result) {
      if (!account) saveSession(result.email, result.token);
      accountInfo = result;
      managingGoogle = false;
    }
  } catch (error) {
    if (!cancelGoogle) showError(error.message);
  } finally {
    popup?.close();
    googlePassword.value = googleConfirm.value = '';
    if (cancelGoogle) managingGoogle = false;
    waitingForGoogle = false;
    busy = false;
    render();
    (managingGoogle ? googlePassword : googleButton).focus();
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !configured) return;
  if (managingGoogle) {
    googleButton.click();
    return;
  }
  const credentials = { email: email.value.trim().toLowerCase(), password: password.value };
  busy = true;
  showError('');
  render();
  try {
    if (account) {
      await request('device-tokens', { method: 'DELETE', token: account.token });
      localStorage.removeItem(sessionKey);
      account = null;
      form.reset();
    } else {
      const deviceId = getDeviceId();
      if (creating) {
        await request('accounts', { body: credentials });
        creating = false;
      }
      const { token } = await request('device-tokens', { body: { ...credentials, deviceId } });
      saveSession(credentials.email, token);
    }
    await refreshGoogle();
  } catch (error) {
    showError(error instanceof DOMException ? 'Le stockage local du compte est inaccessible.' : error.message);
  } finally {
    busy = false;
    render();
    (account ? submitButton : email).focus();
  }
});
