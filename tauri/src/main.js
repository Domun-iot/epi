import { openUrl } from '@tauri-apps/plugin-opener';
import { connect } from './service.js';
import { escapeHtml as e, formatDate, nameKey, sortProfiles, userIcon } from './format.js';
import { createEditor } from './editors.js';
import { filterColumnOptions, measurementDetails, measurementsView } from './measurements-view.js';
import { devicesView, noticesView, profilesView } from './management-view.js';
import './styles.css';

const navigation = document.querySelector('#navigation');
const profilePicker = document.querySelector('#profile');
document.querySelector('#profile-icon').innerHTML = userIcon;
const dataActions = document.querySelector('#data-actions');
const backButton = document.querySelector('#back-to-measurements');
const view = document.querySelector('#view');
const main = view.closest('main');
const notices = document.querySelector('#notices');
const dialog = document.querySelector('#editor');
const status = document.querySelector('#status span:last-child');
const reloadButton = document.querySelector('#reload-data');
const importInput = document.querySelector('#import-files');
const importButton = document.querySelector('#import-data');
const exportButton = document.querySelector('#export-data');
const retryButton = document.querySelector('#retry-bluetooth');
let canRetryBluetooth = false;
let bluetoothUnavailable = false;
const expanded = new Set();
const editor = createEditor(dialog, showError);
const pages = { measurements: 'Mesures', profiles: 'Profils', devices: 'Appareils' };

let session;
let state = { profiles: [], devices: [], measurements: [], pending: [] };
let rows = [];
let reading = null;
let historyScroll;
let columnQuery = '';
let draggedColumn;
let dropColumn;
let errorText = '';
let feedback = '';
let frames = [];
let lastMain = [];
let lastNotices = [];
let lastProfiles = [];

function changed(previous, next) {
  return next.some((value, index) => value !== previous[index]);
}

const currentPage = () => {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(pages, hash) ? hash : 'measurements';
};

function renderProfilePicker() {
  const anonymous = state.measurements.some(row => !row.profile?.name);
  const nextProfiles = [state.selectedProfile, state.profiles, anonymous];
  if (changed(lastProfiles, nextProfiles)) {
    lastProfiles = nextProfiles;
    profilePicker.innerHTML = `<option value="">${anonymous ? 'Sans profil' : 'Choisir un profil'}</option>${sortProfiles(state.profiles).map(({ name }) => `<option value="${e(name)}">${e(name)}</option>`).join('')}`;
    profilePicker.disabled = !state.profiles.length && !anonymous;
  }
  profilePicker.value = state.selectedProfile ?? '';
}

function render() {
  const page = currentPage();
  renderProfilePicker();
  const nextNotices = [state.pending, state.enrollment, errorText || state.acquisitionError, feedback];
  if (changed(lastNotices, nextNotices)) {
    lastNotices = nextNotices;
    notices.innerHTML = noticesView(state, errorText || state.acquisitionError)
      + (feedback ? `<p class="notice" role="status">${e(feedback)}</p>` : '');
  }
  const detail = page === 'measurements' ? reading : null;
  dataActions.hidden = Boolean(detail);
  backButton.hidden = !detail;
  const nextMain = detail ? [page, detail, state.methodColumnOrder] : [page, state.selectedProfile, ...(page === 'measurements'
    ? [state.measurements, state.columns, state.splitColumns, state.columnOrder]
    : page === 'profiles' ? [state.profiles] : [state.devices, state.addressFilter])];
  if (changed(lastMain, nextMain)) {
    lastMain = nextMain;
    if (page === 'measurements') {
      const selected = nameKey(state.selectedProfile) ?? null;
      rows = state.measurements.filter(row => (nameKey(row.profile?.name) ?? null) === selected)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    }
    for (const button of navigation.querySelectorAll('[data-page]')) {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    view.setAttribute('aria-label', detail ? 'Détails de la pesée' : pages[page]);
    main.classList.toggle('measurement-details-page', Boolean(detail));
    const scroll = view.querySelector('.table-scroll')?.scrollLeft;
    const active = document.activeElement;
    const focusedColumn = active?.dataset.column;
    const focusedToggle = active?.dataset.action === 'split-column' ? active.dataset.value : undefined;
    const toggleScope = active?.classList.contains('column-toggle') ? '.column-toggle' : '.column-option button';
    const searchFocused = active?.matches('.column-search');
    const previousComparison = view.querySelector('.comparison-scroll');
    const detailScroll = previousComparison && { left: previousComparison.scrollLeft, top: previousComparison.scrollTop };
    const openSections = new Map(Array.from(view.querySelectorAll('.measurement-details > details'),
      section => [section.querySelector('summary').textContent, section.open]));
    view.innerHTML = detail ? measurementDetails(detail, state.methodColumnOrder)
      : page === 'measurements' ? measurementsView(rows, state.selectedProfile, state.columns, state.splitColumns, state.columnOrder, expanded.has('columns'), columnQuery)
      : page === 'profiles' ? profilesView(state.profiles, state.selectedProfile) : devicesView(state.devices, state.addressFilter, expanded.has('raw'));
    if (detail) {
      view.querySelector('.comparison-scroll')?.scrollTo(detailScroll ?? {});
      for (const section of view.querySelectorAll('.measurement-details > details')) {
        const title = section.querySelector('summary').textContent;
        if (openSections.has(title)) section.open = openSections.get(title);
      }
      return;
    }
    if (page === 'measurements') filterColumnOptions(view, columnQuery);
    if (focusedToggle) view.querySelector(`${toggleScope}[data-action="split-column"][data-value="${CSS.escape(focusedToggle)}"]`)?.focus({ preventScroll: true });
    if (searchFocused) view.querySelector('.column-search')?.focus({ preventScroll: true });
    if (scroll && page === 'measurements') view.querySelector('.table-scroll')?.scrollTo({ left: scroll });
    if (focusedColumn) view.querySelector(`[data-column="${CSS.escape(focusedColumn)}"]`)?.focus({ preventScroll: true });
  }
}

function renderFrames() {
  const output = document.querySelector('#raw-frames');
  if (!output || !output.closest('details').open) return;
  output.textContent = frames.join('\n') || 'Aucune trame reçue.';
}

function showError(error) {
  errorText = error?.message || String(error);
  render();
}

function onState(next) {
  state = next;
  render();
  renderFrames();
}

async function perform(action) {
  if (!session) return;
  errorText = '';
  feedback = '';
  try {
    await action();
    render();
  } catch (error) {
    showError(error);
  }
}

function go(page) {
  if (window.location.hash !== '#' + page) window.location.hash = page;
}

function addProfile(item) {
  editor.profileEditor(null, async profile => {
    await session.saveProfile(profile);
    if (item) await session.confirmProfile({ id: item.id, name: profile.name });
    else await session.selectProfile(profile.name);
  });
}

const actions = {
  'new-profile': () => addProfile(),
  'edit-profile': name => editor.profileEditor(state.profiles.find(profile => profile.name === name), profile => session.saveProfile(profile)),
  'select-profile': name => session.selectProfile(name),
  'new-device': () => editor.deviceEditor({}, request => session.beginDevice(request)),
  'refresh-device': address => {
    const device = state.devices.find(entry => entry.bluetooth.address === address);
    if (device) editor.deviceEditor({ address, device }, request => session.beginDevice(request));
  },
  'cancel-device': () => session.cancelDevice(),
  'clear-filter': () => session.setAddressFilter(null),
  'filter-address': address => session.setAddressFilter(address),
  'filter-custom': () => editor.filterEditor(state.addressFilter, address => session.setAddressFilter(address)),
  'register-pending-device': id => {
    const pending = state.pending.find(item => String(item.id) === id);
    if (pending) editor.deviceEditor({ address: pending.event.address, pending }, request => session.beginDevice(request));
  },
  'assign-profile': id => {
    const pending = state.pending.find(item => String(item.id) === id);
    if (!pending) return;
    editor.assignmentEditor(pending, state.profiles, request => session.confirmProfile(request), () => addProfile(pending), () => {
      editor.profileEditor(null, profile => session.confirmProfile({ id: pending.id, name: null, profile }), true);
    });
  },
  discard: id => {
    const item = state.pending.find(entry => String(entry.id) === id);
    if (item) return session.discardPending(item.id);
  },
  'split-column': id => session.setColumnPreference(state.selectedProfile, id, 'splitColumns',
    !state.splitColumns.includes(id)),
  reading: index => {
    const row = rows[Number(index)];
    if (!row) return;
    historyScroll = { left: view.querySelector('.table-scroll').scrollLeft, top: window.scrollY };
    reading = row;
    render();
    backButton.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  },
  'back-to-measurements': () => {
    const row = reading;
    reading = null;
    render();
    const index = rows.indexOf(row);
    view.querySelector(`[data-action="reading"][data-value="${index}"] .reading-date`)?.focus({ preventScroll: true });
    view.querySelector('.table-scroll')?.scrollTo({ left: historyScroll.left });
    window.scrollTo({ top: historyScroll.top });
  },
};

navigation.addEventListener('click', event => {
  const page = event.target.closest('[data-page]')?.dataset.page;
  if (page === 'measurements' && reading) actions['back-to-measurements']();
  else if (page) go(page);
});
backButton.addEventListener('click', () => actions['back-to-measurements']());
main.addEventListener('click', event => {
  const source = event.target.closest('a.method-source');
  if (source && session?.native) {
    event.preventDefault();
    void perform(() => openUrl(source.href));
    return;
  }
  const control = event.target.closest('[data-action]') ?? event.target.closest('th')?.querySelector('.column-toggle');
  const action = control && actions[control.dataset.action];
  if (action) void perform(() => action(control.dataset.value));
});
const dragSelector = '[data-drag-column]';
let draggedTable;

function dragColumnAt(event) {
  const cell = event.target.closest(dragSelector);
  return cell?.closest('table') === draggedTable ? cell?.dataset.dragColumn : undefined;
}

function markDropColumn(column) {
  if (column === dropColumn) return;
  dropColumn = column;
  for (const cell of draggedTable.querySelectorAll(dragSelector)) {
    cell.classList.toggle('column-drop', cell.dataset.dragColumn === column);
  }
}

function clearColumnDrag() {
  markDropColumn(undefined);
  draggedColumn = undefined;
  draggedTable = undefined;
}

view.addEventListener('dragstart', event => {
  const cell = event.target.closest(dragSelector);
  if (!cell) return;
  draggedColumn = cell.dataset.dragColumn;
  draggedTable = cell.closest('table');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedColumn);
});
view.addEventListener('dragover', event => {
  const column = dragColumnAt(event);
  if (!draggedColumn || !column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  markDropColumn(column === draggedColumn ? undefined : column);
});
view.addEventListener('drop', event => {
  const target = dragColumnAt(event);
  const source = draggedColumn;
  if (!source || !target) return;
  event.preventDefault();
  const isComparison = draggedTable.matches('.comparison-scroll table');
  const order = Array.from(draggedTable.querySelectorAll('thead tr:first-child th[data-drag-column]'),
    cell => cell.dataset.dragColumn);
  clearColumnDrag();
  if (source === target) return;
  const move = isComparison ? session.moveMethodColumn : session.moveColumn;
  void perform(() => move(state.selectedProfile, source, target, order));
});
view.addEventListener('dragend', clearColumnDrag);
view.addEventListener('toggle', event => {
  const group = event.target.dataset.expand;
  if (!group) return;
  if (event.target.open) expanded.add(group);
  else expanded.delete(group);
  if (group === 'raw') renderFrames();
}, true);
view.addEventListener('input', event => {
  if (!event.target.matches('.column-search')) return;
  columnQuery = event.target.value;
  filterColumnOptions(view, columnQuery);
});
view.addEventListener('change', event => {
  const checkbox = event.target;
  const id = checkbox.dataset.column;
  if (!id) return;
  void perform(() => session.setColumnPreference(state.selectedProfile, id, 'columns', checkbox.checked)).then(() => {
    if (checkbox.isConnected) checkbox.checked = state.columns?.includes(id) ?? false;
  });
});
profilePicker.addEventListener('change', () => {
  reading = null;
  const name = profilePicker.value || null;
  void perform(() => session.selectProfile(name)).then(renderProfilePicker);
});
window.addEventListener('hashchange', () => {
  reading = null;
  render();
  renderFrames();
});

async function importArchive(importer) {
  importButton.disabled = true;
  try {
    await perform(async () => {
      const imported = await importer();
      if (imported !== undefined) feedback = 'Import terminé.';
    });
  } finally {
    importButton.disabled = false;
  }
}

reloadButton.addEventListener('click', () => void perform(async () => {
  await session.reload();
  feedback = 'Données rechargées.';
}));

importButton.addEventListener('click', () => {
  if (session?.pickLegacy) void importArchive(() => session.pickLegacy());
  else importInput.click();
});
importInput.addEventListener('change', async () => {
  if (importInput.files.length) await importArchive(() => session.importLegacy(importInput.files[0]));
  importInput.value = '';
});
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  try {
    await perform(async () => {
      if (await session.exportData()) feedback = 'Archive ZIP exportée.';
    });
  }
  finally { exportButton.disabled = false; }
});
retryButton.addEventListener('click', () => void perform(() => session.retryBluetooth?.()));

function renderBluetooth() {
  retryButton.hidden = !canRetryBluetooth || !bluetoothUnavailable;
  status.parentElement.classList.toggle('unavailable', bluetoothUnavailable);
}

try {
  render();
  session = await connect(onState, message => {
    status.textContent = message;
    bluetoothUnavailable = /indisponible|erreur|désactiv|aucun|déconnect|échec|simulation|permission/i.test(message);
    renderBluetooth();
  }, line => {
    frames = [`[${formatDate(Date.now())}] ${line}`, ...frames].slice(0, 50);
    renderFrames();
  });
  reloadButton.hidden = !session.native;
  canRetryBluetooth = Boolean(session.retryBluetooth) && status.textContent !== 'Mode simulation';
  renderBluetooth();
  onState(await session.load());
} catch (error) {
  showError(error);
}
