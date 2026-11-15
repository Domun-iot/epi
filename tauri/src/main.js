import { t, htmlText, messageCode } from './i18n.js';
import { openUrl } from '@tauri-apps/plugin-opener';
import { connect } from './service.js';
import { bluetoothView, createBluetoothWatch } from './bluetooth-watch.js';
import { escapeHtml as e, formatDate, nameKey, sortByName, userIcon } from './format.js';
import { createEditor } from './editors.js';
import { filterColumnOptions, measurementDetails, measurementsView } from './measurements-view.js';
import { renderChartDates, snapChartRange } from './measurement-charts.js';
import { viewPresetHeader, viewPresetTitles } from './view-presets.js';
import { notificationBody, notificationDetailHeader, notificationRecordView, notificationsView, resolveNotification } from './notifications-view.js';
import { devicesView, noticesView, profilesView } from './management-view.js';

import { startTransactionSync, requestTransactionSync } from './transaction-sync.js';
import { enableLanguageSelection } from './account.js';

const navigation = document.querySelector('#navigation');
const profilePicker = document.querySelector('#profile');
const profileName = document.querySelector('#profile-name');
const themeToggle = document.querySelector('#theme-toggle');
const themeColor = document.querySelector('meta[name=theme-color]');
const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)');
const profileIcon = document.querySelector('#profile-icon');
profileIcon.insertAdjacentHTML('afterbegin', userIcon);
const dataActions = document.querySelector('#data-actions');
const backButton = document.querySelector('#back-to-measurements');
const restoreButton = document.querySelector('#restore-button');
const detailActions = document.querySelector('#detail-actions');
const deleteMeasurementButton = document.querySelector('#delete-measurement-button');
const view = document.querySelector('#view');
const main = view.closest('main');
const viewHeader = document.querySelector('#view-header');
const viewScroll = document.querySelector('#view-scroll');
const viewContent = document.querySelector('#view-content');
const notices = document.querySelector('#notices');
const pendingActions = document.querySelector('#pending-actions');
const notificationIcon = document.querySelector('#notifications-icon');
const dialog = document.querySelector('#editor');
const statusLink = document.querySelector('#status');
const status = statusLink.querySelector('span:last-child');
const bluetoothWatch = createBluetoothWatch();
const reloadButton = document.querySelector('#reload-data');
const importInput = document.querySelector('#import-files');
const importButton = document.querySelector('#import-data');
const exportButton = document.querySelector('#export-data');
const retryButton = document.querySelector('#retry-bluetooth');
let canRetryBluetooth = false;
let bluetoothUnavailable = false;
let columnsOpen = false;
const desktopSearchFocus = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const panelStates = new WeakMap();
const editorView = document.querySelector('#editor-view');
const editor = createEditor(dialog, editorView, document.querySelector('#editor-actions'), renderEditorView);
const pages = { measurements: t('measurements'), profiles: t('profiles'), devices: t('devices'), notifications: t('notifications'), bluetooth: t('bluetoothMonitor') };

let session;
let state = { profiles: [], devices: [], measurements: [], pending: [], notifications: [] };
let rows = [];
let reading = null;
let historyScroll;
let columnQuery = '';
let chartSelection;
let notificationId = null;
let activeNotice = null;
let noticeQueue = [];
let closingNotice = false;
let bannerTimeout;
let previousAcquisitionError;
let notificationDeadline;
let initializedNotifications = false;
let frames = [];
let lastMain = [];
let lastNotices = [];
let lastBanner = [];
let lastProfiles = [];
let scrollBeforeEditor;
let previewDeviceCapture;

function changed(previous, next) {
  return next.some((value, index) => value !== previous[index]);
}

const currentPage = () => {
  const [hash] = window.location.hash.slice(1).split('/');
  return Object.hasOwn(pages, hash) ? hash : 'measurements';
};

function renderProfilePicker() {
  const anonymous = state.measurements.some(row => !row.profile?.name);
  const nextProfiles = [state.selectedProfile, state.profiles, anonymous];
  if (changed(lastProfiles, nextProfiles)) {
    lastProfiles = nextProfiles;
    profilePicker.innerHTML = `<option value="">${anonymous ? htmlText('withoutProfile') : htmlText('chooseAProfile')}</option>${sortByName(state.profiles).map(({ name }) => `<option value="${e(name)}">${e(name)}</option>`).join('')}`;
    const count = state.profiles.length;
    profilePicker.hidden = count < 2;
    profileName.hidden = count !== 1;
    profileName.textContent = count === 1 ? state.profiles[0].name : '';
    profileIcon.title = count > 1 ? t('openProfiles') : count === 1 ? t('editProfile') : t('createAProfile');
    profileIcon.setAttribute('aria-label', count === 1 ? `${profileIcon.title} ${profileName.textContent}` : profileIcon.title);
  }
  profilePicker.value = state.selectedProfile ?? '';
}

function renderEditorView() {
  const editing = !editorView.hidden;
  previewDeviceCapture = undefined;
  if (editing) scrollBeforeEditor ??= viewScroll.scrollTop;
  for (const element of [viewHeader, viewContent]) element.hidden = editing;
  pendingActions.inert = editing;
  render();
  viewScroll.scrollTop = editing ? 0 : scrollBeforeEditor ?? 0;
  if (!editing) {
    scrollBeforeEditor = undefined;
    if (reading && currentPage() === 'measurements') backButton.focus({ preventScroll: true });
  }
}

function render() {
  const page = currentPage();
  renderProfilePicker();
  renderTheme();
  if (page === 'bluetooth') statusLink.setAttribute('aria-current', 'page');
  else statusLink.removeAttribute('aria-current');
  notificationIcon.hidden = state.notifications.length === 0;
  notificationIcon.setAttribute('aria-pressed', String(page === 'notifications'));
  renderBanner();
  const nextNotices = [state.pending, state.enrollment];
  if (changed(lastNotices, nextNotices)) {
    lastNotices = nextNotices;
    pendingActions.innerHTML = noticesView(state);
    pendingActions.hidden = !state.pending.length && !state.enrollment;
  }
  const selectedNotice = page === 'notifications' ? state.notifications.find(item => item.id === notificationId) : null;
  const target = resolveNotification(state, selectedNotice);
  const entry = target?.type === 'pending' ? null : selectedNotice;
  const detail = page === 'measurements' ? reading : null;
  const editing = !editorView.hidden;
  dataActions.hidden = editing || Boolean(detail || entry);
  detailActions.hidden = editing || (!detail && !entry);
  backButton.hidden = detailActions.hidden;
  deleteMeasurementButton.hidden = detailActions.hidden || !(detail || (target?.type === 'measurement' && target.live));
  const restoreAction = target?.action === 'deleted' && !target.live ? 'restore-notification' : '';
  restoreButton.hidden = editing || !restoreAction;
  restoreButton.dataset.action = restoreAction;
  restoreButton.dataset.value = target?.id ?? '';
  const kind = detail ? 'details' : 'measurements';
  const layout = page === 'measurements' ? state.viewLayouts?.[kind] : undefined;
  const layoutKey = layout ? [layout.presets, layout.preset, layout.modified, ...Object.values(layout.layout)] : [];
  const nextMain = page === 'bluetooth' ? [page, state.addressFilter, state.devices, session?.web]
    : detail ? [page, detail, state.selectedProfile, ...layoutKey] : [page, state.selectedProfile, ...(page === 'measurements'
    ? [state.measurements, state.measurementDisplay, state.chartOptions?.mode, state.chartOptions?.period,
      ...(state.chartOptions?.range ?? []), ...(state.chartLastRange ?? []), ...Object.values(state.chartSeries ?? {}), ...layoutKey]
    : page === 'profiles' ? [state.profiles] : page === 'devices' ? [state.devices, state.addressFilter]
      : [state.notifications, notificationId, state.devices, target?.record])];
  if (changed(lastMain, nextMain)) {
    const pageChanged = lastMain[0] !== page;
    lastMain = nextMain;
    if (page === 'measurements') {
      const selected = nameKey(state.selectedProfile) ?? null;
      const profile = state.profiles.find(item => nameKey(item.name) === selected);
      rows = state.measurements.filter(row => row.profile?.uuid ? row.profile.uuid === profile?.uuid
        : (nameKey(row.profile?.name) ?? null) === selected)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    }
    for (const button of navigation.querySelectorAll('[data-page]')) {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    view.setAttribute('aria-label', detail ? t('weighInDetails') : pages[page]);
    const scroll = view.querySelector('.table-scroll')?.scrollLeft;
    const active = document.activeElement;
    const focusedColumn = active?.dataset.column;
    const focusedToggle = active?.dataset.action === 'split-column' ? active.dataset.value : undefined;
    const focusedDisplay = active?.dataset.action === 'measurement-display' ? active.dataset.value : undefined;
    const focusedChartControl = ['chart-period', 'chart-mode', 'chart-axis', 'chart-fullscreen'].includes(active?.dataset.action);
    const toggleScope = active?.classList.contains('column-toggle') ? '.column-toggle' : '.column-option button';
    const searchFocused = active?.matches('.column-search');
    const previousComparison = view.querySelector('.comparison-scroll');
    const detailScroll = previousComparison?.scrollLeft;
    const previousPinnedTable = view.querySelector('.pinned-header');
    if (previousPinnedTable) pinnedHeaderResize.unobserve(previousPinnedTable);
    stopReorder();
    const header = layout && viewPresetHeader(kind, layout);
    const focusedPresetAction = active?.closest('.view-preset-header') && active.dataset.action;
    const markup = detail ? measurementDetails(detail, state.methodColumnOrder, state.detailSectionOrder, state.detailSectionsOpen, header)
      : page === 'measurements' ? measurementsView(rows, state.selectedProfile, state.columns, state.splitColumns, state.columnOrder,
        columnsOpen, columnQuery, header, state.measurementDisplay, { ...state.chartOptions, lastRange: state.chartLastRange, statuses: state.chartSeries })
      : page === 'profiles' ? profilesView(state.profiles, state.selectedProfile)
      : page === 'devices' ? devicesView(state.devices, state.addressFilter, state.rawOpen, !session?.web)
      : page === 'bluetooth' ? bluetoothView(state, session?.web)
      : !entry ? notificationsView(state)
      : target.type === 'measurement'
        ? measurementDetails(target.record, state.methodColumnOrder, state.detailSectionOrder, state.detailSectionsOpen,
          notificationDetailHeader(target, t('weighInDetails')), formatDate)
        : notificationRecordView(target);
    viewHeader.innerHTML = markup.header;
    chartDatesResize.disconnect();
    chartHeightResize.disconnect();
    chartHeadingResize.disconnect();
    const hadChart = Boolean(viewContent.querySelector('.measurement-chart'));
    viewContent.innerHTML = markup.content;
    const chart = viewContent.querySelector('.measurement-chart');
    if (chart) {
      updateChartFullscreenButton();
      const heading = chart.querySelector('.chart-heading');
      alignChartControls(heading);
      chartHeadingResize.observe(heading);
    } else if (document.fullscreenElement === viewContent) void perform(() => document.exitFullscreen());
    const chartDates = viewContent.querySelector('.chart-dates');
    if (chartDates) chartDatesResize.observe(chartDates);
    bluetoothWatch.attach(viewContent.querySelector('#bluetooth-log'), state.addressFilter);
    if (pageChanged) {
      viewScroll.scrollTop = 0;
      focusRecord();
    }
    for (const panel of view.querySelectorAll('details[data-expand="raw"], details[data-detail-section]')) {
      panelStates.set(panel, panel.open);
    }
    if (focusedPresetAction || active?.matches('.view-preset-picker summary')) {
      const control = view.querySelector(`.view-preset-header [data-action="${CSS.escape(focusedPresetAction)}"]:not(:disabled)`);
      (control ?? view.querySelector('.view-preset-picker summary'))?.focus({ preventScroll: true });
    }
    renderFrames();
    const pinnedTable = view.querySelector('.pinned-header');
    if (pinnedTable) pinnedHeaderResize.observe(pinnedTable);
    positionPinnedHeader();
    if (detail) {
      const comparison = view.querySelector('.comparison-scroll');
      if (comparison) comparison.scrollLeft = detailScroll ?? 0;
      return;
    }
    if (page === 'measurements') filterColumnOptions(view, columnQuery);
    if (focusedToggle) view.querySelector(`${toggleScope}[data-action="split-column"][data-value="${CSS.escape(focusedToggle)}"]`)?.focus({ preventScroll: true });
    if (focusedDisplay) view.querySelector(`[data-action="measurement-display"][data-value="${CSS.escape(focusedDisplay)}"]`)?.focus({ preventScroll: true });
    if (focusedChartControl) {
      const value = active.dataset.value;
      const filter = value === undefined ? '' : `[data-value="${CSS.escape(value)}"]`;
      view.querySelector(`[data-action="${active.dataset.action}"]${filter}`)?.focus({ preventScroll: true });
    }
    if (searchFocused) view.querySelector('.column-search')?.focus({ preventScroll: true });
    if (scroll && page === 'measurements') view.querySelector('.table-scroll')?.scrollTo({ left: scroll });
    if (focusedColumn) view.querySelector(`[data-column="${CSS.escape(focusedColumn)}"]`)?.focus({ preventScroll: true });
    if (chart) {
      updateChartHeight();
      for (const element of [viewScroll, viewHeader, ...viewContent.children]) {
        if (element !== chart) chartHeightResize.observe(element);
      }
      if (!hadChart) viewScroll.scrollTop = viewScroll.scrollHeight;
    }
  }
}

function renderFrames() {
  const output = document.querySelector('#raw-frames');
  if (!output || !output.closest('details').open) return;
  output.textContent = frames.join('\n') || t('noFramesReceived');
}

function renderBanner() {
  if (!activeNotice || closingNotice) return;
  const next = [activeNotice];
  if (!changed(lastBanner, next)) return;
  lastBanner = next;
  const error = activeNotice.type === 'error';
  notices.innerHTML = `<article class="notice notification-banner${error ? ' error' : ''}"${error ? ' role="alert"' : ''}>
    <div class="notification-summary">${notificationBody(activeNotice, state)}</div>
    <button class="button" type="button" data-action="dismiss-banner">${htmlText('dismissNotice')}</button>
  </article>`;
}

function bannerDuration(entry) {
  if (entry.type === 'error') return 0;
  return entry.type === 'info' ? 3000 : entry.durationMs;
}

function enqueueBanners(entries) {
  noticeQueue.push(...entries);
  if (activeNotice || closingNotice || !noticeQueue.length) return;
  activeNotice = noticeQueue.shift();
  renderBanner();
  notices.inert = false;
  // Commit the collapsed frame before beginning the transition.
  notices.getBoundingClientRect();
  notices.classList.add('is-open');
  const duration = bannerDuration(activeNotice);
  if (duration) bannerTimeout = window.setTimeout(dismissBanner, duration);
}

function dismissBanner() {
  if (!activeNotice || closingNotice) return;
  closingNotice = true;
  window.clearTimeout(bannerTimeout);
  if (notices.contains(document.activeElement)) notificationIcon.focus({ preventScroll: true });
  notices.inert = true;
  notices.classList.remove('is-open');
  window.setTimeout(() => {
    notices.replaceChildren();
    activeNotice = null;
    closingNotice = false;
    enqueueBanners([]);
  }, 180);
}

function showError(error) {
  const entry = { type: 'error', text: error?.message || String(error), banner: true };
  if (session) void session.recordNotice(entry).catch(() => enqueueBanners([entry]));
  else enqueueBanners([entry]);
}

function scheduleNotificationExpiry() {
  window.clearTimeout(notificationDeadline);
  const first = state.notifications.length > 20
    ? state.notifications.reduce((earliest, item) => item.date < earliest.date ? item : earliest)
    : null;
  if (first && session) notificationDeadline = window.setTimeout(() => {
    void session.pruneNotifications().catch(showError);
  }, Math.max(100, Date.parse(first.date) + 7 * 86400_000 - Date.now()));
}

function onState(next) {
  const previous = state;
  state = next;
  let savedMeasurement;
  if (previous.notifications !== state.notifications) {
    const known = new Map(previous.notifications.map(item => [item.id, item]));
    const current = new Map(state.notifications.map(item => [item.id, item]));
    if (activeNotice && !closingNotice) activeNotice = current.get(activeNotice.id) ?? activeNotice;
    noticeQueue = noticeQueue.map(item => current.get(item.id) ?? item);
    const incoming = state.notifications.filter(item => item.banner && !known.has(item.id)
      && item.type !== 'pending' && item.type !== 'enrollment');
    if (initializedNotifications) {
      const savedNotice = incoming.findLast(item => item.type === 'measurement' && item.action === 'saved');
      if (savedNotice) savedMeasurement = state.measurements.find(row => row.uuid === savedNotice.record.uuid);
      enqueueBanners(incoming);
    }
    initializedNotifications = true;
    scheduleNotificationExpiry();
  }
  if (next.acquisitionError && next.acquisitionError !== previousAcquisitionError) showError(next.acquisitionError);
  previousAcquisitionError = next.acquisitionError;
  previewDeviceCapture?.(state.pending);
  if (savedMeasurement) openMeasurement(savedMeasurement);
  else render();
  renderFrames();
}

async function perform(action) {
  if (!session) return;
  try {
    await action();
    render();
  } catch (error) {
    showError(error);
  }
}

function focusRecord() {
  const fragment = window.location.hash.slice(1);
  const card = fragment.includes('/') && document.getElementById(fragment);
  if (card) {
    card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
  }
}

function go(page, uuid) {
  const fragment = uuid ? `${page}/${uuid}` : page;
  if (window.location.hash !== '#' + fragment) window.location.hash = fragment;
  else if (uuid) focusRecord();
}

function openMeasurement(row) {
  const onMeasurements = currentPage() === 'measurements';
  if (!onMeasurements) window.history.pushState(null, '', '#measurements');
  if (!onMeasurements || !reading) {
    historyScroll = {
      left: onMeasurements ? view.querySelector('.table-scroll')?.scrollLeft ?? 0 : 0,
      top: onMeasurements ? scrollBeforeEditor ?? viewScroll.scrollTop : 0,
      chartSeries: document.activeElement?.closest('.chart-point')?.dataset.series,
    };
  }
  if (!editorView.hidden) scrollBeforeEditor = 0;
  reading = row;
  render();
  backButton.focus({ preventScroll: true });
  viewScroll.scrollTop = 0;
}

function editProfile(profile) {
  if (!profile) return;
  editor.profileEditor(profile, fields => session.saveProfile(fields), false, {
    onDelete: () => editor.confirmDeletion(t('deleteProfile'),
      t('confirmDeleteProfile', [profile.name]),
      async () => {
        await session.deleteProfile(profile.name);
        editor.closeView();
      }),
  });
}

function addProfile(item) {
  editor.profileEditor(null, async profile => {
    await session.saveProfile(profile);
    if (item) await session.confirmProfile({ id: item.id, name: profile.name });
    else await session.selectProfile(profile.name);
  });
}

function changeViewPreset(action, id) {
  const kind = reading ? 'details' : 'measurements';
  const profile = state.selectedProfile;
  const { preset, modified } = state.viewLayouts[kind];
  if (action === 'select' || action === 'reset') {
    const picker = view.querySelector('.view-preset-picker');
    picker.open = false;
    picker.querySelector('summary').focus();
    return session.changeViewPreset(profile, kind, action, { id: id || null });
  }
  if (action === 'delete' && preset) {
    editor.deleteViewEditor(preset.name, () => session.changeViewPreset(profile, kind, action, { id: preset.id }));
  } else if (action === 'rename' && !preset && modified) {
    editor.viewNameEditor('create', '', name => session.changeViewPreset(profile, kind, 'create', { name }));
  } else if (action === 'save' || preset) {
    editor.viewNameEditor(action, preset?.name ?? viewPresetTitles[kind], name =>
      session.changeViewPreset(profile, kind, action, { id: preset?.id, name }));
  }
}

const actions = {
  'open-notification': async id => {
    const target = resolveNotification(state, state.notifications.find(item => item.id === id));
    if (target?.type === 'pending') {
      await session.replayReceipt(id);
      go('measurements');
      const receipt = pendingActions.querySelector(`[data-pending-id="${CSS.escape(String(target.pendingId))}"]`);
      receipt?.scrollIntoView({ block: 'nearest' });
      receipt?.querySelector('button')?.focus({ preventScroll: true });
      return;
    }
    if (target?.type === 'profile' && target.live) return editProfile(target.record);
    if (target?.type === 'device' && target.live) return go('devices', target.record.uuid);
    if (target?.type === 'profile' && target.action === 'deleted') {
      editor.profileEditor(target.record, profile => {
        editor.confirmRestoreProfile(target.measurements.length, async include => {
          await session.restoreNotification(target.id, include, profile);
          editor.closeView();
          go('profiles', target.record.uuid);
        });
        return false;
      }, false, { restore: true });
      return;
    }
    notificationId = id;
    render();
    viewScroll.scrollTop = 0;
    backButton.focus();
  },
  'delete-notification': id => editor.confirmDeletion(t('deleteNotification'),
    t('confirmDeleteNotification'),
    async () => {
      await session.deleteNotification(id);
      noticeQueue = noticeQueue.filter(item => item.id !== id);
      if (activeNotice?.id === id) dismissBanner();
    }),
  'delete-all-notifications': () => editor.confirmDeletion(t('clearAllNotifications'),
    t('confirmDeleteAllNotifications'),
    async () => {
      await session.deleteAllNotifications();
      noticeQueue = [];
      dismissBanner();
    }),
  'restore-notification': async id => {
    const entry = state.notifications.find(item => item.id === id);
    await session.restoreNotification(id);
    if (entry?.type === 'device') go('devices', entry.record.uuid);
  },
  'select-view-preset': id => changeViewPreset('select', id),
  'reset-view-preset': id => changeViewPreset('reset', id),
  'save-view-preset': () => changeViewPreset('save'),
  'rename-view-preset': () => changeViewPreset('rename'),
  'delete-view-preset': () => changeViewPreset('delete'),
  'new-profile': () => addProfile(),
  'edit-profile': name => editProfile(state.profiles.find(profile => profile.name === name)),
  'select-profile': name => session.selectProfile(name),
  'delete-measurement': () => {
    const target = notificationId && resolveNotification(state, state.notifications.find(entry => entry.id === notificationId));
    const row = reading ?? (target?.live ? target.record : null);
    if (!row) return;
    editor.confirmDeletion(t('deleteWeighIn'), t('confirmDeleteWeighIn', [formatDate(row.receivedAt)]), async () => {
      await session.deleteMeasurement(row);
      if (reading === row) actions['back-to-measurements']();
    });
  },
  'new-device': () => {
    const previous = new Set(state.pending.map(item => item.id));
    const showCapture = editor.deviceEditor({}, request => session.beginDevice(request));
    let captureAddress;
    previewDeviceCapture = pending => {
      const candidates = pending.filter(item => item.reason === 'device' && !previous.has(item.id));
      const candidate = candidates.find(item => item.event.address === captureAddress) ?? candidates[0];
      captureAddress = candidate?.event.address;
      showCapture(candidate ?? null);
    };
  },
  'edit-device': address => {
    const device = state.devices.find(entry => entry.bluetooth.address === address);
    if (!device) return;
    editor.deviceEditor({
      address, device,
      onDelete: () => editor.confirmDeletion(t('deleteDevice'),
        t('confirmDeleteDevice', [device.name]), async () => {
          await session.deleteDevice(address);
          editor.closeView();
        }),
    }, request => session.renameDevice(request));
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
  'chart-fullscreen': () => document.fullscreenElement === viewContent
    ? document.exitFullscreen() : viewContent.requestFullscreen(),
  'chart-period': period => session.setChartOptions(state.selectedProfile,
    state.viewLayouts.measurements.preset?.id ?? null, period === 'custom' ? { range: state.chartLastRange } : { period }),
  'chart-mode': mode => session.setChartOptions(state.selectedProfile,
    state.viewLayouts.measurements.preset?.id ?? null, { mode }),
  'chart-axis': id => session.cycleChartSeries(state.selectedProfile, state.viewLayouts.measurements.preset?.id ?? null, id),
  'measurement-display': display => session.setMeasurementDisplay(state.selectedProfile, display,
    state.viewLayouts.measurements.preset?.id ?? null),
  'split-column': id => session.setColumnPreference(state.selectedProfile, id, 'splitColumns',
    !state.splitColumns.includes(id)),
  reading: index => {
    const row = rows[Number(index)];
    if (row) openMeasurement(row);
  },
  'back-to-measurements': () => {
    const row = reading;
    reading = null;
    render();
    const index = rows.indexOf(row);
    const point = historyScroll.chartSeries && view.querySelector(
      `.chart-point[data-series="${CSS.escape(historyScroll.chartSeries)}"][data-value="${index}"]`);
    (point ?? view.querySelector(`[data-action="reading"][data-value="${index}"] .reading-date`))?.focus({ preventScroll: true });
    view.querySelector('.table-scroll')?.scrollTo({ left: historyScroll.left });
    viewScroll.scrollTop = historyScroll.top;
  },
};

function openProfiles() {
  if (state.profiles.length > 1) navigation.querySelector('[data-page="profiles"]').click();
  else if (state.profiles.length === 1) void perform(() => editProfile(state.profiles[0]));
  else if (editorView.hidden) void perform(() => addProfile());
}

profileIcon.addEventListener('click', openProfiles);
navigation.addEventListener('click', event => {
  const page = event.target.closest('[data-page]')?.dataset.page;
  if (page && !editorView.hidden) editor.closeView();
  if (page === 'measurements' && reading) actions['back-to-measurements']();
  else if (page) go(page);
});
notificationIcon.addEventListener('click', () => {
  editor.closeView();
  notificationId = null;
  if (currentPage() === 'notifications') render();
  else go('notifications');
});
deleteMeasurementButton.addEventListener('click', () => void perform(actions['delete-measurement']));
restoreButton.addEventListener('click', () => {
  const { action, value } = restoreButton.dataset;
  void perform(() => actions[action](value));
});
backButton.addEventListener('click', () => {
  if (currentPage() === 'notifications') {
    notificationId = null;
    render();
    return;
  }
  actions['back-to-measurements']();
});
notices.addEventListener('click', dismissBanner);
main.addEventListener('click', event => {
  const columnsSummary = event.target.closest('details[data-expand="columns"] > summary');
  if (columnsSummary && desktopSearchFocus) {
    requestAnimationFrame(() => {
      const panel = columnsSummary.parentElement;
      if (panel?.isConnected && panel.open) panel.querySelector('.column-search')?.focus();
    });
  }
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
document.addEventListener('click', event => {
  const picker = view.querySelector('.view-preset-picker[open]');
  if (picker && !picker.contains(event.target)) picker.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!editorView.hidden) {
    editor.closeView();
    return;
  }
  const picker = event.target.closest('.view-preset-picker[open]');
  if (!picker) return;
  picker.open = false;
  picker.querySelector('summary').focus();
});

function positionPinnedHeader() {
  const panel = view.querySelector('.pinned-header');
  if (!panel) return;
  const table = panel.querySelector('table');
  const { top, height } = table.getBoundingClientRect();
  // The table handles horizontal overflow while the view scrolls vertically.
  const scrollBoundary = viewScroll.getBoundingClientRect().top;
  const distance = scrollBoundary - top;
  // Overlap the clipping edge to cover fractional-pixel rounding during scroll.
  const offset = distance > 0 ? Math.min(Math.max(0, distance - 1), height - table.tHead.offsetHeight) : 0;
  panel.style.setProperty('--header-offset', `${offset}px`);
}

function updateChartFullscreenButton() {
  const button = viewContent.querySelector('[data-action="chart-fullscreen"]');
  if (!button) return;
  const fullscreen = document.fullscreenElement === viewContent;
  button.setAttribute('aria-pressed', String(fullscreen));
  button.title = fullscreen ? t('exitFullScreen') : t('fullScreen');
}

document.addEventListener('fullscreenchange', () => {
  updateChartFullscreenButton();
  updateChartHeight();
});

function updateChartHeight() {
  const chart = viewContent.querySelector('.measurement-chart');
  if (!chart || document.fullscreenElement === viewContent || !chart.getClientRects().length) return;
  const contentTop = viewScroll.getBoundingClientRect().top + parseFloat(getComputedStyle(viewScroll).paddingTop);
  const leadingSpace = chart.getBoundingClientRect().top - contentTop + viewScroll.scrollTop;
  chart.style.setProperty('--chart-leading-space', `${leadingSpace}px`);
}

function alignChartControls(heading) {
  const [title, controls] = heading.children;
  controls.classList.toggle('chart-controls-wrapped',
    controls.getBoundingClientRect().top >= title.getBoundingClientRect().bottom);
}

const chartHeadingResize = new ResizeObserver(([{ target }]) => alignChartControls(target));
const chartHeightResize = new ResizeObserver(updateChartHeight);
const chartDatesResize = new ResizeObserver(([{ target, contentRect }]) => renderChartDates(target, contentRect.width));
const pinnedHeaderResize = new ResizeObserver(positionPinnedHeader);
pinnedHeaderResize.observe(viewScroll);
pinnedHeaderResize.observe(viewHeader);
viewScroll.addEventListener('scroll', positionPinnedHeader, { passive: true });

const columnCell = '[data-drag-column]';
const columnHeader = 'thead [data-drag-column]';
const sectionHeader = '[data-detail-section] > summary';
let reorder;
let tablePan;
let suppressReorderClick = false;

function stopReorder() {
  if (!reorder) return;
  for (const element of reorder.highlighted) element.classList.remove('column-drop');
  for (const cell of reorder.sourceCells) cell.classList.remove('column-drag-source');
  reorder.table?.classList.remove('column-drag-left');
  reorder = undefined;
}

function reorderTargetAt(event) {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (reorder.table) {
    const cell = hit?.closest(columnCell);
    return cell?.closest('table') === reorder.table ? cell.dataset.dragColumn : undefined;
  }
  return hit?.closest(sectionHeader);
}

view.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  suppressReorderClick = false;
  const plot = event.target.closest('.chart-plot[data-start]');
  if (plot && event.pointerType === 'mouse') {
    chartSelection = {
      plot, preview: plot.querySelector('.chart-selection'), pointerId: event.pointerId, x: event.clientX,
    };
    return;
  }
  const element = event.target.closest(`${columnHeader}, ${sectionHeader}`);
  if (!element) {
    const panel = event.target.closest('tbody')?.closest('.table-scroll');
    if (event.pointerType === 'mouse' && panel) {
      const vertical = panel.closest('#view-scroll') ?? document.scrollingElement;
      tablePan = {
        panel, vertical, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        left: panel.scrollLeft, top: vertical.scrollTop,
      };
    }
    return;
  }
  const table = element.closest('table');
  const source = table ? element.dataset.dragColumn : element;
  const sourceCells = table ? Array.from(table.querySelectorAll(columnCell)).filter(cell => cell.dataset.dragColumn === source) : [];
  reorder = {
    table, source, sourceCells,
    pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    active: false, highlighted: [],
  };
});

view.addEventListener('dragstart', event => {
  if (reorder || tablePan || chartSelection) event.preventDefault();
});

window.addEventListener('pointermove', event => {
  if (event.pointerId === chartSelection?.pointerId) {
    updateChartSelection(event.clientX);
    return;
  }
  if (event.pointerId === tablePan?.pointerId) {
    const { panel, vertical, x, y, left, top } = tablePan;
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    if (!suppressReorderClick && Math.hypot(dx, dy) < 6) return;
    suppressReorderClick = true;
    panel.scrollLeft = left - dx;
    vertical.scrollTop = top - dy;
    return;
  }
  if (event.pointerId !== reorder?.pointerId) return;
  if (!reorder.active) {
    if (Math.hypot(event.clientX - reorder.x, event.clientY - reorder.y) < 6) return;
    reorder.active = true;
    suppressReorderClick = true;
  }
  const hit = reorderTargetAt(event);
  const target = hit === reorder.source ? undefined : hit;
  if (target === reorder.target) return;
  for (const element of reorder.highlighted) element.classList.remove('column-drop');
  reorder.target = target;
  for (const cell of reorder.sourceCells) cell.classList.toggle('column-drag-source', Boolean(target));
  reorder.highlighted = !target ? [] : reorder.table
    ? Array.from(reorder.table.querySelectorAll(columnCell)).filter(cell => cell.dataset.dragColumn === target)
    : [target];
  if (reorder.table) {
    const headers = Array.from(reorder.table.tHead.rows[0].cells);
    const sourceIndex = headers.findIndex(cell => cell.dataset.dragColumn === reorder.source);
    const targetIndex = headers.findIndex(cell => cell.dataset.dragColumn === target);
    reorder.table.classList.toggle('column-drag-left', targetIndex >= 0 && targetIndex < sourceIndex);
  }
  for (const element of reorder.highlighted) element.classList.add('column-drop');
});

function updateChartSelection(x) {
  const { plot, preview, x: origin } = chartSelection;
  if (!plot.isConnected || Math.abs(x - origin) < 6) {
    preview.hidden = true;
    return;
  }
  suppressReorderClick = true;
  const { left, width } = plot.getBoundingClientRect();
  const fraction = clientX => Math.max(0, Math.min(1, (clientX - left) / width));
  const first = fraction(Math.min(origin, x));
  const last = fraction(Math.max(origin, x));
  if (first === last) {
    preview.hidden = true;
    return;
  }
  const start = Number(plot.dataset.start);
  const duration = Number(plot.dataset.end) - start;
  const [rangeStart, rangeEnd] = snapChartRange(start + first * duration, start + last * duration);
  const leftPercent = Math.max(0, (rangeStart - start) / duration * 100);
  const rightPercent = Math.min(100, (rangeEnd - start) / duration * 100);
  preview.style.left = `${leftPercent}%`;
  preview.style.width = `${rightPercent - leftPercent}%`;
  preview.hidden = false;
  return [rangeStart, rangeEnd];
}

function stopChartSelection() {
  if (chartSelection) chartSelection.preview.hidden = true;
  chartSelection = undefined;
}

window.addEventListener('pointerup', event => {
  if (event.pointerId === chartSelection?.pointerId) {
    const range = updateChartSelection(event.clientX);
    stopChartSelection();
    if (range && range[0] < range[1]) {
      void perform(() => session.setChartOptions(state.selectedProfile,
        state.viewLayouts.measurements.preset?.id ?? null, { range }));
    }
    return;
  }
  if (event.pointerId === tablePan?.pointerId) tablePan = undefined;
  if (event.pointerId !== reorder?.pointerId) return;
  const { active, table, source } = reorder;
  const target = active && reorderTargetAt(event);
  stopReorder();
  if (!target || source === target) return;
  if (table) {
    const order = Array.from(table.tHead.rows[0].cells, cell => cell.dataset.dragColumn).filter(Boolean);
    const move = table.matches('.comparison-scroll table') ? session.moveMethodColumn : session.moveColumn;
    void perform(() => move(state.selectedProfile, source, target, order, JSON.parse(table.dataset.defaultOrder)));
  } else {
    const details = source.closest('.measurement-details');
    const order = Array.from(details.querySelectorAll('[data-detail-section]'), section => section.dataset.detailSection);
    void perform(() => session.moveDetailSection(state.selectedProfile, source.parentElement.dataset.detailSection,
      target.parentElement.dataset.detailSection, order, JSON.parse(details.dataset.defaultOrder)));
  }
});

window.addEventListener('pointercancel', event => {
  if (event.pointerId === chartSelection?.pointerId) stopChartSelection();
  if (event.pointerId === tablePan?.pointerId) tablePan = undefined;
  if (event.pointerId === reorder?.pointerId) stopReorder();
});
window.addEventListener('blur', () => {
  stopChartSelection();
  tablePan = undefined;
  stopReorder();
});
view.addEventListener('click', event => {
  if (!suppressReorderClick || event.detail === 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressReorderClick = false;
}, true);
view.addEventListener('toggle', event => {
  const panel = event.target;
  const group = panel.dataset.expand;
  if (group === 'columns') columnsOpen = panel.open;
  if (group === 'raw') renderFrames();
  if (!panelStates.has(panel) || panelStates.get(panel) === panel.open) return;
  panelStates.set(panel, panel.open);
  void perform(() => session.setPanelOpen(state.selectedProfile, panel.dataset.detailSection ?? null, panel.open));
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
function isDarkTheme() {
  return state.theme === 'dark' || (state.theme !== 'light' && preferredTheme.matches);
}

function renderTheme() {
  if (state.theme === 'light' || state.theme === 'dark') document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
  const dark = isDarkTheme();
  const label = dark ? t('enableLightMode') : t('enableDarkMode');
  themeColor.content = dark ? '#101827' : '#f5f7fa';
  themeToggle.setAttribute('aria-label', label);
  themeToggle.title = label;
}

renderTheme();
preferredTheme.addEventListener('change', renderTheme);
themeToggle.addEventListener('click', async () => {
  const profile = state.selectedProfile ?? null;
  const theme = isDarkTheme() ? 'light' : 'dark';
  themeToggle.disabled = true;
  try {
    await perform(() => session.setTheme(profile, theme));
  } finally {
    themeToggle.disabled = false;
  }
});

profilePicker.addEventListener('change', () => {
  editor.closeView();
  reading = null;
  const name = profilePicker.value || null;
  void perform(() => session.selectProfile(name)).then(renderProfilePicker);
});
function renderPageChange() {
  reading = null;
  notificationId = null;
  if (!editorView.hidden) {
    scrollBeforeEditor = 0;
    editor.closeView();
  }
  render();
  focusRecord();
  renderFrames();
}
window.addEventListener('hashchange', renderPageChange);

async function importArchive(importer) {
  importButton.disabled = true;
  try {
    await perform(async () => {
      const imported = await importer();
      if (imported !== undefined) await session.recordNotice({ type: 'info', text: messageCode('importCompleted'), banner: true });
    });
  } finally {
    importButton.disabled = false;
  }
}

const archiveButtons = [exportButton, importButton];
const dataActionsResize = new ResizeObserver(() => {
  if (dataActions.hidden) return;
  dataActions.classList.remove('compact');
  const compact = importButton.getBoundingClientRect().right > dataActions.getBoundingClientRect().right;
  dataActions.classList.toggle('compact', compact);
  for (const button of archiveButtons) {
    if (compact) button.title = button.firstElementChild.textContent;
    else button.removeAttribute('title');
  }
});
dataActionsResize.observe(dataActions);
dataActionsResize.observe(reloadButton);
for (const button of archiveButtons) dataActionsResize.observe(button.firstElementChild);

reloadButton.addEventListener('click', () => void perform(async () => {
  await session.reload();
  await session.recordNotice({ type: 'info', text: messageCode('dataReloaded'), banner: true });
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
      if (await session.exportData()) {
        await session.recordNotice({ type: 'info', text: messageCode('zipExported'), banner: true });
      }
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
  session = await connect(onState, (message, unavailable = false) => {
    status.textContent = message;
    bluetoothUnavailable = unavailable;
    renderBluetooth();
  }, line => {
    if (!line.startsWith('PAYLOAD ')) {
      frames = [`[${formatDate(Date.now())}] ${line}`, ...frames].slice(0, 50);
      renderFrames();
    }
    bluetoothWatch.receive(line);
  }, () => {
    if (currentPage() === 'bluetooth') {
      window.history.pushState(null, '', '#measurements');
      renderPageChange();
    }
  }, requestTransactionSync);
  startTransactionSync(session);
  enableLanguageSelection(session.setLanguagePreference);
  themeToggle.disabled = false;
  reloadButton.hidden = !session.native && !session.web;
  canRetryBluetooth = Boolean(session.retryBluetooth);
  renderBluetooth();
  onState(await session.load());
  scheduleNotificationExpiry();
} catch (error) {
  showError(error);
}
