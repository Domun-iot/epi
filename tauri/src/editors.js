import { t, htmlText, localizeMessage } from './i18n.js';
import { button, deviceFields, escapeHtml as e, pageHeader, pairs, sortByName, weight } from './format.js';

import { domain } from 'virtual:epi-domain';

const { buildDevice } = domain;
const field = (label, name, attributes) => `<label>${e(label)}<input name="${name}" ${attributes}></label>`;
const option = (value, label, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;

export function createEditor(dialog, view, toolbar, onViewChange) {
  let previousFocus;

  function closeView() {
    if (view.hidden) return;
    view.hidden = true;
    toolbar.hidden = true;
    view.replaceChildren();
    toolbar.replaceChildren();
    onViewChange();
    previousFocus?.focus({ preventScroll: true });
    previousFocus = null;
  }

  function open(title, content, submit, submitLabel = t('save'), {
    modal = false, extraActions = '', deleteAction = '', submitChoices = [], subtitle = '', hidePendingWeighIns = false,
  } = {}) {
    const host = modal ? dialog : view;
    const formId = modal ? 'modal-editor-form' : 'view-editor-form';
    const submitButton = submitLabel ? `<button class="button primary" type="submit" form="${formId}">${e(submitLabel)}</button>` : '';
    const choices = submitChoices.map(({ label, value, primary }) =>
      `<button class="button${primary ? ' primary' : ''}" type="submit" form="${formId}" name="include" value="${value}">${e(label)}</button>`).join('');
    const actions = `${extraActions}${button(t('cancel'), 'close-editor')}${deleteAction}${submitButton}${choices}`;
    host.innerHTML = `${modal ? `<h2 id="dialog-title">${e(title)}</h2>` : pageHeader(title, subtitle)}
      <form id="${formId}" class="editor-form${modal ? '' : ' panel'}"${hidePendingWeighIns ? ' data-hide-pending-weigh-ins' : ''}>${content}<p class="notice error" role="alert" hidden></p></form>
      ${modal ? `<div class="actions">${actions}</div>` : ''}`;
    const controls = modal ? dialog : toolbar;
    if (!modal) controls.innerHTML = actions;
    const form = host.querySelector('form');
    const buttons = new Set([...controls.querySelectorAll('button'), ...form.querySelectorAll('button')]);
    const close = () => modal ? dialog.close() : closeView();
    let submitting = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitting) return;
      const values = new FormData(form, event.submitter);
      submitting = true;
      const error = form.querySelector('[role="alert"]');
      for (const control of buttons) control.disabled = true;
      error.hidden = true;
      try {
        const result = await submit(Object.fromEntries(values));
        if (result !== false && form.isConnected) close();
      } catch (exception) {
        error.textContent = localizeMessage(exception?.message || String(exception));
        error.hidden = false;
      } finally {
        submitting = false;
        for (const control of buttons) control.disabled = false;
      }
    });
    controls.querySelector('[data-action="close-editor"]').addEventListener('click', close);
    if (modal) dialog.oncancel = event => {
      if (submitting) event.preventDefault();
    };
    if (modal) {
      dialog.showModal();
    } else {
      if (view.hidden) previousFocus = document.activeElement;
      view.hidden = false;
      toolbar.hidden = false;
      onViewChange();
      const firstField = form.querySelector('input:not([readonly]):not([disabled]):not([type="hidden"]), select:not([disabled])');
      if (firstField) firstField.focus({ preventScroll: true });
      else {
        const heading = host.querySelector('h1');
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    return form;
  }

  function profileEditor(profile, submit, anonymous = false, { restore = false, onDelete } = {}) {
    const edit = Boolean(profile) && !restore;
    const ageType = profile?.age != null && !profile?.birthDate ? 'age' : 'birthDate';
    const title = restore ? t('restoreProfile')
      : anonymous ? t('calculateWithoutSavedProfile') : edit ? t('editProfile') : t('createAProfile');
    const form = open(title, `
      ${anonymous ? '' : field(t('name'), 'name', `value="${e(profile?.name)}" maxlength="64" required autofocus`)}
      <label>${htmlText('sexForCalculations')}<select name="sex" required>${option('', t('choose'), false)}${option('H', t('male'), profile?.sex === 'H')}${option('F', t('female'), profile?.sex === 'F')}</select></label>
      <label>${htmlText('ageUsedByFormulas')}<select name="ageType">${option('birthDate', t('dateOfBirth'), ageType === 'birthDate')}${option('age', t('fixedAge'), ageType === 'age')}</select></label>
      ${field(t('dateOfBirth'), 'birthDate', `type="date" value="${e(profile?.birthDate)}"`)}
      ${field(t('ageYears'), 'age', `type="number" min="0" max="120" step="1" value="${e(profile?.age)}"`)}
      ${field(t('heightCm'), 'heightCm', `type="number" min="100" max="250" step="any" inputmode="decimal" value="${e(profile?.heightCm)}" required`)}
    `, async ({ name, sex, age, birthDate, ageType: source, heightCm }) => {
      const data = { sex, heightCm: Number(heightCm) };
      if (!anonymous) data.name = name.trim().normalize('NFC');
      if (edit) data.editUuid = profile.uuid;
      if (source === 'age') data.age = Number(age);
      else data.birthDate = birthDate;
      return submit(data);
    }, restore ? t('restore') : t('save'), {
      hidePendingWeighIns: !edit && !restore && !anonymous,
      subtitle: restore ? t('thisProfileHasBeenDeleted') : '',
      deleteAction: edit && onDelete ? button(t('delete'), 'delete-profile') : '',
    });
    if (edit && onDelete) toolbar.querySelector('[data-action="delete-profile"]').addEventListener('click', onDelete);
    const selector = form.querySelector('[name="ageType"]');
    const syncAge = () => ['age', 'birthDate'].forEach(name => {
      const input = form.querySelector(`[name="${name}"]`);
      const visible = selector.value === name;
      input.closest('label').hidden = !visible;
      input.disabled = !visible;
      input.required = visible;
    });
    selector.addEventListener('change', syncAge);
    syncAge();
  }

  function deviceEditor({ address, device, pending, onDelete }, submit) {
    const title = device ? t('editDevice') : t('addADevice');
    const explanation = device ? '' : pending ? t('scaleFrameReceived')
      : t('stepOnScale');
    const form = open(title, `${explanation ? `<p class="muted" data-device-instructions>${e(explanation)}</p>` : ''}
      ${field(t('deviceName'), 'name', `value="${e(device?.name)}" maxlength="64" required autofocus`)}
      <div data-device-details hidden></div>
    `, ({ name }) => submit({ ...(address ? { address } : {}), name: name.trim() }),
    device || pending ? t('save') : t('startCapturing'), {
      hidePendingWeighIns: !device,
      deleteAction: onDelete ? button(t('delete'), 'delete-device') : '',
    });
    if (onDelete) toolbar.querySelector('[data-action="delete-device"]').addEventListener('click', onDelete);

    const details = form.querySelector('[data-device-details]');
    const instructions = form.querySelector('[data-device-instructions]');
    const save = toolbar.querySelector('[type="submit"]');
    let displayed;
    function showCapture(capture) {
      if (!form.isConnected || capture === displayed) return;
      displayed = capture;
      address = capture?.event.address ?? device?.bluetooth.address;
      const bluetooth = capture
        ? buildDevice('Balance', capture.event, capture.bluetoothMetadata ?? {}).bluetooth
        : device?.bluetooth;
      details.innerHTML = bluetooth ? pairs(deviceFields(device ?? { bluetooth })) : '';
      details.hidden = !bluetooth;
      if (instructions) instructions.textContent = capture ? t('scaleFrameReceived') : explanation;
      save.textContent = device || capture ? t('save') : t('startCapturing');
    }
    showCapture(pending ?? null);
    return showCapture;
  }

  function assignmentEditor(pending, profiles, submit, create, anonymous) {
    const profileItems = sortByName(profiles).map(({ name }) => {
      const firstName = name.trim().split(/\s+/, 1)[0];
      return `<li><button class="button assignment-profile" type="submit" name="name" value="${e(name)}">
        <span class="assignment-name">${e(firstName)}</span><span class="button">${htmlText('select')}</span>
      </button></li>`;
    }).join('');
    open(t('assignWeighIn'), `<p>${htmlText('weighInFrom')} <strong>${weight(pending.event)}</strong>.</p>
      ${profileItems ? `<ul class="assignment-profiles list" aria-label="${htmlText('profiles')}">${profileItems}</ul>`
        : `<p class="muted">${htmlText('noProfilesOnThisDevice')}</p>`}`,
    ({ name }) => submit({ id: pending.id, name }), null, {
      hidePendingWeighIns: true,
      extraActions: button(t('createAProfile'), 'create-for-reading', { primary: profiles.length === 0 })
        + button(t('calculateWithoutProfile'), 'calculate-one-off', { primary: profiles.length > 0 }),
    });
    toolbar.querySelector('[data-action="calculate-one-off"]').addEventListener('click', anonymous);
    toolbar.querySelector('[data-action="create-for-reading"]').addEventListener('click', create);
  }

  function filterEditor(address, submit) {
    open(t('filterByBluetoothAddress'), field(t('bluetoothAddress'), 'address',
      `value="${e(address)}" placeholder="AA:BB:CC:DD:EE:FF" maxlength="36" required autofocus`),
    values => submit(values.address), t('applyFilter'));
  }

  function viewNameEditor(action, current, submit) {
    const rename = action === 'rename';
    const title = action === 'create' ? t('createViewPreset') :
      rename ? t('renameViewPreset') : t('saveViewPreset');
    const form = open(title,
      field(t('name'), 'name', `value="${e(current)}" maxlength="64" required autofocus`),
      ({ name }) => submit(name), rename ? t('rename') : t('savePreset'), { modal: rename || action === 'create' });
    form.querySelector('[name="name"]').select();
  }

  function confirmDeletion(title, message, submit) {
    open(title, `<p>${e(message)}</p>`, submit, t('delete'), { modal: true });
    dialog.querySelector('[data-action="close-editor"]').focus();
  }

  function deleteViewEditor(name, submit) {
    confirmDeletion(t('deleteViewPreset'), t('confirmDeletePreset', [name]), submit);
  }

  function confirmRestoreProfile(count, submit) {
    open(t('restoreProfile'), `<p>${htmlText('restoreProfileWeighIns', [count])}</p>`,
      ({ include }) => submit(include === 'yes'), null, {
        modal: true,
        submitChoices: [{ label: t('no'), value: 'no' }, { label: t('yes'), value: 'yes', primary: true }],
      });
  }

  return { closeView, profileEditor, deviceEditor, assignmentEditor, filterEditor, viewNameEditor, deleteViewEditor,
    confirmDeletion, confirmRestoreProfile };
}
