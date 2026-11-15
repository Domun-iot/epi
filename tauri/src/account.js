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
  closeButton.disabled = busy;
  submitButton.disabled = busy || !configured;
  submitButton.textContent = account ? 'Se déconnecter' : creating ? 'Créer le compte' : 'Se connecter';
  form.setAttribute('aria-busy', String(busy));
}

const errors = {
  account_exists: 'Un compte existe déjà pour cette adresse.',
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
    throw new Error(Object.hasOwn(errors, result?.error) ? errors[result.error] : 'Le serveur a renvoyé une erreur.');
  }
  return result;
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
});

closeButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => {
  if (busy) event.preventDefault();
});
dialog.addEventListener('close', () => form.reset());

switchButton.addEventListener('click', () => {
  creating = !creating;
  password.value = '';
  showError('');
  render();
  email.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !configured) return;
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
      if (typeof token !== 'string' || !token) throw new Error('Le serveur a renvoyé un jeton invalide.');
      const session = { email: credentials.email, token };
      localStorage.setItem(sessionKey, JSON.stringify(session));
      account = session;
      form.reset();
    }
  } catch (error) {
    showError(error instanceof DOMException ? 'Le stockage local du compte est inaccessible.' : error.message);
  } finally {
    busy = false;
    render();
    (account ? submitButton : email).focus();
  }
});
