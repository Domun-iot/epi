import { languages, locale, localizeMessage, t, useAccountLanguage, useInterfaceLanguage } from './i18n.js';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

const productionApi = 'https://sync.epi.invalid';
const api = __DEV_ACCOUNT_API__ ?? productionApi;
const configured = !api.endsWith('.invalid');
const sessionKey = 'epi-account:' + api;
const deviceKey = 'epi-account-device';

const openButton = document.querySelector('#account-button');
const connectionStatus = document.querySelector('#account-connection-status');
const dialog = document.querySelector('#account-dialog');
const title = document.querySelector('#account-title');
const form = document.querySelector('#account-form');
const fields = document.querySelector('#account-fields');
const email = form.elements.email;
const password = form.elements.password;
const language = form.elements.language;
const languageOptions = Object.entries(languages).sort(([, first], [, second]) => first.localeCompare(second, locale));
language.replaceChildren(...languageOptions.map(([id, name]) => new Option(name, id, id === locale, id === locale)));
const accountEmail = document.querySelector('#account-email');
const errorNotice = document.querySelector('#account-error');
const switchButton = document.querySelector('#account-switch');
const closeButton = document.querySelector('#account-close');
const submitButton = document.querySelector('#account-submit');
const publicPages = dialog.querySelectorAll('[data-account-public-page]');

const googleButton = document.querySelector('#account-google');
const googleButtonLogo = googleButton.querySelector('img');
const googleButtonLabel = googleButton.querySelector('span');
const googleFields = document.querySelector('#account-google-fields');
const googlePasswordLabel = document.querySelector('#account-google-password-label');
const googlePassword = form.elements.googlePassword;
const googleConfirmField = document.querySelector('#account-google-confirm-field');
const googleConfirm = form.elements.googlePasswordConfirm;
const googleStatus = document.querySelector('#account-google-status');

let accountInfo = null;
let managingGoogle = false;
let waitingForGoogle = false;
let cancelGoogle = false;
let account = null;
let connectionCheck;
let connectionError = '';
let creating = false;
let registrationLanguage;
let saveLanguage;
let busy = false;

const chosenLocale = () => creating ? registrationLanguage : undefined;

export function enableLanguageSelection(save) {
  saveLanguage = save;
  render();
}

function readAccount() {
  const saved = JSON.parse(localStorage.getItem(sessionKey));
  return typeof saved?.email === 'string' && typeof saved.token === 'string' && saved.token ? saved : null;
}

export function syncToken() {
  try { return configured ? readAccount()?.token : undefined; }
  catch { return undefined; }
}

window.addEventListener('storage', event => {
  if (event.key !== sessionKey && event.key !== null) return;
  const token = account?.token;
  loadSavedSession();
  if (account?.token !== token) {
    void checkAccountConnection();
    window.dispatchEvent(new Event('epi:account'));
  }
});

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
  for (const link of publicPages) {
    const url = new URL(link.href);
    url.searchParams.set('lang', locale);
    link.href = url.href;
  }
  openButton.dataset.connected = String(Boolean(accountInfo));
  connectionStatus.textContent = t(accountInfo ? 'accountConnected' : 'accountDisconnected');
  openButton.title = connectionStatus.textContent;
  title.textContent = account ? t('account') : creating ? t('createAccount') : t('signInHeading');
  accountEmail.hidden = !account;
  accountEmail.textContent = account?.email ?? '';
  fields.hidden = Boolean(account);
  language.disabled = busy || !(saveLanguage || creating);
  email.disabled = password.disabled = busy || Boolean(account);
  password.autocomplete = creating ? 'new-password' : 'current-password';
  switchButton.hidden = Boolean(account) || !configured;
  switchButton.disabled = busy;
  switchButton.textContent = creating ? t('backToSignIn') : t('createAccount');
  const needsNewPassword = managingGoogle && !accountInfo?.hasPassword;
  googleFields.hidden = !managingGoogle;
  googlePasswordLabel.textContent = needsNewPassword ? t('newPassword') : t('currentPassword');
  googlePassword.autocomplete = needsNewPassword ? 'new-password' : 'current-password';
  googlePassword.disabled = busy || !managingGoogle;
  googleConfirmField.hidden = !needsNewPassword;
  googleConfirm.disabled = busy || !needsNewPassword;
  googleButton.hidden = Boolean(account && !accountInfo);
  googleButton.disabled = busy;
  googleButtonLogo.hidden = Boolean(accountInfo?.googleLinked);
  const signingIn = !account && !creating;
  googleButtonLabel.textContent = signingIn ? 'Google' : !account ? t('registerWithGoogle')
    : accountInfo?.googleLinked ? t('unlinkGoogle') : t('linkGoogle');
  if (signingIn) googleButton.setAttribute('aria-label', t('signInWithGoogle'));
  else googleButton.removeAttribute('aria-label');
  googleStatus.hidden = !waitingForGoogle;
  googleStatus.textContent = waitingForGoogle ? t('completeGoogleSignIn') : '';
  const closingAccount = !waitingForGoogle && !managingGoogle;
  closeButton.disabled = busy && !waitingForGoogle;
  closeButton.textContent = closingAccount ? t('close') : t('cancel');
  closeButton.classList.toggle('primary', closingAccount && Boolean(accountInfo));
  submitButton.disabled = busy || !configured;
  submitButton.hidden = managingGoogle;
  submitButton.classList.toggle('primary', !account);
  submitButton.textContent = account ? t('signOut') : creating ? t('submitAccountRegistration') : t('signIn');
  form.setAttribute('aria-busy', String(busy));
}

if (isTauri()) {
  for (const link of publicPages) {
    link.addEventListener('click', async event => {
      event.preventDefault();
      try { await openUrl(link.href); }
      catch { showError(t('accountServerUnavailable')); }
    });
  }
}

const errors = {
  account_exists: t('accountAlreadyExists'),
  google_disabled: t('googleSignInDisabled'),
  google_busy: t('accountServerBusy'),
  google_attempt_expired: t('googleRequestExpired'),
  google_failed: t('googleSignInFailed'),
  google_conflict: t('googleLinkConflict'),
  google_wrong_account: t('chooseLinkedGoogleAccount'),
  google_unverified_email: t('googleEmailNotVerified'),
  google_not_linked: t('googleAccountNotLinked'),
  invalid_token: t('sessionExpired'),
  token_expired: t('sessionExpired'),
  invalid_credentials: t('incorrectEmailAddressOrPassword'),
  invalid_credentials_format: t('checkCredentials'),
};

async function request(path, { method = 'POST', body, token, contentType = 'application/json' } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = contentType;
  if (token) headers.Authorization = 'Bearer ' + token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  let result;
  try {
    response = await fetch(api + '/v1/' + path, {
      method,
      headers,
      body: body && (contentType === 'application/json' ? JSON.stringify(body) : body),
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 204) return;
    result = await response.json().catch(() => null);
  } catch {
    throw new Error(t('accountServerUnavailable'));
  } finally {
    clearTimeout(timeout);
  }
  if (controller.signal.aborted) throw new Error(t('accountServerUnavailable'));
  if (!response.ok || !result) {
    const error = new Error(Object.hasOwn(errors, result?.error) ? errors[result.error] : t('accountServerError'));
    error.code = result?.error;
    throw error;
  }
  return result;
}

export function uploadTransactions(body, token) {
  return request('transactions', { body, token, contentType: 'application/x-ndjson' });
}

export function downloadTransactions(token, after) {
  const query = after ? '?after=' + encodeURIComponent(after) : '';
  return request('transactions/pending' + query, { method: 'GET', token });
}

export function acknowledgeTransactions(token, uuids) {
  return request('transactions/acknowledge', { body: { uuids }, token });
}

function showConnectionError(message) {
  if (dialog.open && (errorNotice.hidden || errorNotice.textContent === connectionError)) showError(message);
  connectionError = message;
}

function setSession(session, info = null) {
  if (session && creating) {
    creating = false;
    language.value = locale;
  }
  account = session;
  accountInfo = info;
  connectionCheck = undefined;
  managingGoogle = false;
  showConnectionError('');
  render();
}

function loadSavedSession() {
  let saved = null;
  let error = '';
  try {
    if (configured) saved = readAccount();
  } catch {
    error = t('savedSessionUnavailable');
  }
  if (saved?.token !== account?.token) setSession(saved);
  return error;
}

function clearSession() {
  localStorage.removeItem(sessionKey);
  setSession(null);
  window.dispatchEvent(new Event('epi:account'));
}

function saveSession(email, token, info) {
  if (typeof email !== 'string' || typeof token !== 'string' || !token) {
    throw new Error(t('invalidServerSession'));
  }
  const session = { email, token };
  localStorage.setItem(sessionKey, JSON.stringify(session));
  setSession(session, info);
  window.dispatchEvent(new Event('epi:account'));
  form.reset();
}

export function checkAccountConnection() {
  if (!account) return;
  if (connectionCheck?.pending) return connectionCheck.pending;
  const check = {};
  connectionCheck = check;
  check.pending = refreshAccountInfo(account.token, check).finally(() => {
    if (connectionCheck === check) connectionCheck = undefined;
  });
  return check.pending;
}

async function refreshAccountInfo(token, check) {
  try {
    const info = await request('account', { method: 'GET', token });
    if (connectionCheck !== check || syncToken() !== token) return;
    if (typeof info?.email !== 'string') throw new Error(t('accountServerError'));
    accountInfo = info;
    showConnectionError('');
  } catch (error) {
    if (connectionCheck !== check || syncToken() !== token) return;
    accountInfo = null;
    managingGoogle = false;
    let message = error.message;
    if (['invalid_token', 'token_expired'].includes(error.code)) {
      const previousEmail = account.email;
      try {
        clearSession();
        if (dialog.open) email.value = previousEmail;
      } catch {
        message = t('accountStorageUnavailable');
      }
    }
    showConnectionError(message);
  } finally {
    render();
  }
}

loadSavedSession();
render();

openButton.addEventListener('click', () => {
  creating = false;
  registrationLanguage = undefined;
  const savedSessionError = loadSavedSession();
  showError(configured ? savedSessionError || connectionError : t('accountServerNotConfigured'));
  render();
  dialog.showModal();
  void checkAccountConnection();
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

language.addEventListener('change', async () => {
  if (busy) return;
  const preference = language.value;
  if (creating) {
    registrationLanguage = preference;
    return;
  }
  if (!saveLanguage) return;
  busy = true;
  render();
  try {
    await saveLanguage(preference);
    useInterfaceLanguage(preference);
  } catch (error) {
    language.value = locale;
    showError(localizeMessage(error?.message ?? String(error)));
  } finally {
    busy = false;
    render();
    language.focus();
  }
});

closeButton.addEventListener('click', closeAccount);
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeAccount();
});
dialog.addEventListener('close', () => form.reset());

switchButton.addEventListener('click', () => {
  creating = !creating;
  language.value = chosenLocale() ?? locale;
  password.value = '';
  showError('');
  render();
  email.focus();
});

async function finishGoogle(action, body, popup, token) {
  const { state, secret, url } = await request('google/start', { body: { action, interfaceLocale: locale, ...body }, token });
  const target = new URL(url);
  if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') {
    throw new Error(t('invalidGoogleUrl'));
  }
  if (cancelGoogle) return;
  if (popup) popup.location.href = target.href;
  else {
    try {
      await openUrl(target.href);
    } catch {
      // Tauri can reject the IPC call with a string containing the OAuth URL.
      throw new Error(errors.google_failed);
    }
  }

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
  if (!configured) {
    showError(t('accountServerNotConfigured'));
    return;
  }
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
    showError(value ? t('bothPasswordsMustBeTheSame') : t('enterThePassword'));
    googlePassword.focus();
    return;
  }
  let popup;
  if (!directUnlink && !isTauri()) {
    popup = window.open('', '_blank');
    if (!popup) {
      showError(t('allowGoogleSignInTab'));
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
    const body = account ? { password: value } : { deviceId: getDeviceId(), locale: chosenLocale() };
    const token = account?.token;
    const result = directUnlink
      ? await request('google/unlink', { body, token })
      : await finishGoogle(action, body, popup, token);
    if (result) {
      if (!token) saveSession(result.email, result.token, result);
      else if (token === syncToken()) setSession(account, result);
      useAccountLanguage(result.locale ?? body.locale, result.googleLocale);
      managingGoogle = false;
    }
  } catch (error) {
    if (!cancelGoogle) showError(error?.message || errors.google_failed);
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
      clearSession();
      form.reset();
      useAccountLanguage();
    } else {
      const deviceId = getDeviceId();
      const preference = chosenLocale();
      if (creating) {
        await request('accounts', { body: { ...credentials, locale: preference } });
        creating = false;
        language.value = locale;
      }
      const result = await request('device-tokens', { body: { ...credentials, deviceId } });
      saveSession(credentials.email, result.token);
      useAccountLanguage(result.locale ?? preference, result.googleLocale);
    }
    await checkAccountConnection();
  } catch (error) {
    showError(error instanceof DOMException ? t('accountStorageUnavailable') : error.message);
  } finally {
    busy = false;
    render();
    (account ? submitButton : email).focus();
  }
});
