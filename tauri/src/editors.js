import { button, deviceFields, escapeHtml as e, pageHeader, pairs, sortByName, weight } from './format.js';

import domain from 'virtual:epi-session';

const { buildDevice } = domain;
const field = (label, name, attributes) => `<label>${label}<input name="${name}" ${attributes}></label>`;
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

  function open(title, content, submit, submitLabel = 'Enregistrer', { modal = false, extraActions = '' } = {}) {
    const host = modal ? dialog : view;
    const formId = modal ? 'modal-editor-form' : 'view-editor-form';
    const submitButton = submitLabel ? `<button class="button primary" type="submit" form="${formId}">${submitLabel}</button>` : '';
    const actions = `${extraActions}${button('Annuler', 'close-editor')}${submitButton}`;
    host.innerHTML = `${modal ? `<h2 id="dialog-title">${title}</h2>` : pageHeader(title)}
      <form id="${formId}" class="editor-form${modal ? '' : ' panel'}">${content}<p class="notice error" role="alert" hidden></p></form>
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
        await submit(Object.fromEntries(values));
        if (form.isConnected) close();
      } catch (exception) {
        error.textContent = exception?.message || String(exception);
        error.hidden = false;
      } finally {
        submitting = false;
        for (const control of buttons) control.disabled = false;
      }
    });
    controls.querySelector('[data-action="close-editor"]').addEventListener('click', close);
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

  function profileEditor(profile, submit, anonymous = false) {
    const edit = Boolean(profile);
    const ageType = profile?.age != null && !profile?.birthDate ? 'age' : 'birthDate';
    const form = open(anonymous ? 'Calculer sans profil enregistré' : edit ? 'Modifier le profil' : 'Créer un profil', `
      ${anonymous ? '' : field('Nom', 'name', `value="${e(profile?.name)}" maxlength="64" required ${edit ? 'readonly' : 'autofocus'}`)}
      <label>Sexe utilisé par les formules<select name="sex" required>${option('', 'Choisir', false)}${option('H', 'Homme', profile?.sex === 'H')}${option('F', 'Femme', profile?.sex === 'F')}</select></label>
      <label>Âge utilisé par les formules<select name="ageType">${option('birthDate', 'Date de naissance', ageType === 'birthDate')}${option('age', 'Âge fixe', ageType === 'age')}</select></label>
      ${field('Date de naissance', 'birthDate', `type="date" value="${e(profile?.birthDate)}"`)}
      ${field('Âge (ans)', 'age', `type="number" min="0" max="120" step="1" value="${e(profile?.age)}"`)}
      ${field('Taille (cm)', 'heightCm', `type="number" min="100" max="250" step="any" inputmode="decimal" value="${e(profile?.heightCm)}" required`)}
    `, async ({ name, sex, age, birthDate, ageType: source, heightCm }) => {
      const data = { sex, heightCm: Number(heightCm) };
      if (!anonymous) data.name = name.trim().normalize('NFC');
      if (edit) data.editName = profile.name;
      if (source === 'age') data.age = Number(age);
      else data.birthDate = birthDate;
      await submit(data);
    });
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

  function deviceEditor({ address, device, pending }, submit) {
    const title = device ? 'Renommer' : 'Ajouter un appareil';
    const explanation = device ? '' : pending ? 'La trame de cette balance a déjà été reçue.'
      : 'Montez sur la balance pour recevoir ses données Bluetooth.';
    const form = open(title, `${explanation ? `<p class="muted" data-device-instructions>${explanation}</p>` : ''}
      ${field('Nom de l’appareil', 'name', `value="${e(device?.name)}" maxlength="64" required autofocus`)}
      <div data-device-details hidden></div>
    `, ({ name }) => submit({ ...(address ? { address } : {}), name: name.trim() }),
    device || pending ? 'Enregistrer' : 'Démarrer la capture');

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
      if (instructions) instructions.textContent = capture ? 'La trame de cette balance a déjà été reçue.' : explanation;
      save.textContent = device || capture ? 'Enregistrer' : 'Démarrer la capture';
    }
    showCapture(pending ?? null);
    return showCapture;
  }

  function assignmentEditor(pending, profiles, submit, create, anonymous) {
    const profileItems = sortByName(profiles).map(({ name }) => {
      const firstName = name.trim().split(/\s+/, 1)[0];
      return `<li><button class="button assignment-profile" type="submit" name="name" value="${e(name)}">
        <span class="assignment-name">${e(firstName)}</span><span class="button">Sélectionner</span>
      </button></li>`;
    }).join('');
    open('Attribuer la pesée', `<p>Pesée de <strong>${weight(pending.event)}</strong>.</p>
      ${profileItems ? `<ul class="assignment-profiles list" aria-label="Profils">${profileItems}</ul>`
        : '<p class="muted">Aucun profil sur cet appareil.</p>'}`,
    ({ name }) => submit({ id: pending.id, name }), null, {
      extraActions: button('Créer un profil', 'create-for-reading', { primary: profiles.length === 0 })
        + button('Calculer sans profil', 'calculate-one-off', { primary: profiles.length > 0 }),
    });
    toolbar.querySelector('[data-action="calculate-one-off"]').addEventListener('click', anonymous);
    toolbar.querySelector('[data-action="create-for-reading"]').addEventListener('click', create);
  }

  function filterEditor(address, submit) {
    open('Filtrer par adresse Bluetooth', field('Adresse Bluetooth', 'address',
      `value="${e(address)}" placeholder="AA:BB:CC:DD:EE:FF" maxlength="36" required autofocus`),
    values => submit(values.address), 'Appliquer le filtre');
  }

  function viewNameEditor(action, current, submit) {
    const rename = action === 'rename';
    const title = action === 'create' ? 'Créer une configuration' :
      rename ? 'Renommer la configuration' : 'Sauvegarder la configuration';
    const form = open(title,
      field('Nom', 'name', `value="${e(current)}" maxlength="64" required autofocus`),
      ({ name }) => submit(name), rename ? 'Renommer' : 'Sauvegarder', { modal: rename || action === 'create' });
    form.querySelector('[name="name"]').select();
  }

  function deleteViewEditor(name, submit) {
    open('Supprimer la configuration', `<p>Supprimer « ${e(name)} » pour tous les profils ?</p>`, submit, 'Supprimer', { modal: true });
  }

  return { closeView, profileEditor, deviceEditor, assignmentEditor, filterEditor, viewNameEditor, deleteViewEditor };
}
