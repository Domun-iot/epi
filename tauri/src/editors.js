import { button, deviceFields, escapeHtml as e, pairs, weight } from './format.js';

const field = (label, name, attributes) => `<label>${label}<input name="${name}" ${attributes}></label>`;
const option = (value, label, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;

export function createEditor(dialog, onError) {
  function open(title, content, submit, submitLabel = 'Enregistrer') {
    if (dialog.open) dialog.close();
    dialog.innerHTML = `<h2 id="dialog-title">${title}</h2>`;
    dialog.insertAdjacentHTML('beforeend', `<form>${content}<p class="notice error" role="alert" hidden></p>
      <div class="actions">${button('Annuler', 'close-dialog')}<button class="button primary" type="submit">${submitLabel}</button></div></form>`);
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const error = form.querySelector('[role="alert"]');
      const save = form.querySelector('[type="submit"]');
      save.disabled = true;
      error.hidden = true;
      try {
        await submit(Object.fromEntries(new FormData(form)));
        if (dialog.contains(form)) dialog.close();
      } catch (exception) {
        error.textContent = exception?.message || String(exception);
        error.hidden = false;
      } finally {
        save.disabled = false;
      }
    });
    dialog.querySelector('[data-action="close-dialog"]').addEventListener('click', () => dialog.close());
    dialog.showModal();
  }

  function profileEditor(profile, submit, anonymous = false) {
    const edit = Boolean(profile);
    const ageType = profile?.age != null && !profile?.birthDate ? 'age' : 'birthDate';
    open(anonymous ? 'Calculer sans profil enregistré' : edit ? 'Modifier le profil' : 'Créer un profil', `
      ${anonymous ? '' : field('Nom', 'name', `value="${e(profile?.name)}" maxlength="64" required ${edit ? 'readonly' : 'autofocus'}`)}
      <label>Sexe utilisé par les formules<select name="sex" required>${option('', 'Choisir', false)}${option('H', 'Homme', profile?.sex === 'H')}${option('F', 'Femme', profile?.sex === 'F')}</select></label>
      <label>Âge utilisé par les formules<select name="ageType">${option('birthDate', 'Date de naissance', ageType === 'birthDate')}${option('age', 'Âge fixe', ageType === 'age')}</select></label>
      ${field('Date de naissance', 'birthDate', `type="date" value="${e(profile?.birthDate)}"`)}
      ${field('Âge (ans)', 'age', `type="number" min="18" max="120" step="1" value="${e(profile?.age)}"`)}
      ${field('Taille (cm)', 'heightCm', `type="number" min="100" max="250" step="any" inputmode="decimal" value="${e(profile?.heightCm)}" required`)}
    `, async ({ name, sex, age, birthDate, ageType: source, heightCm }) => {
      const data = { sex, heightCm: Number(heightCm) };
      if (!anonymous) data.name = name.trim().normalize('NFC');
      if (edit) data.editName = profile.name;
      if (source === 'age') data.age = Number(age);
      else data.birthDate = birthDate;
      await submit(data);
    });
    const selector = dialog.querySelector('[name="ageType"]');
    const syncAge = () => ['age', 'birthDate'].forEach(name => {
      const input = dialog.querySelector(`[name="${name}"]`);
      const visible = selector.value === name;
      input.closest('label').hidden = !visible;
      input.disabled = !visible;
      input.required = visible;
    });
    selector.addEventListener('change', syncAge);
    syncAge();
  }

  function deviceEditor({ address, device, pending }, submit) {
    const title = device ? 'Actualiser la fiche' : 'Ajouter un appareil';
    const explanation = pending ? 'La trame de cette balance a déjà été reçue.'
      : 'Après validation, montez sur la balance pour transmettre ses données Bluetooth.';
    const captured = device ?? (pending ? {
      bluetooth: pending.event,
    } : null);
    open(title, `<p class="muted">${explanation}</p>
      ${field('Nom de l’appareil', 'name', `value="${e(device?.name)}" maxlength="64" required autofocus`)}
      ${captured ? pairs(deviceFields(captured)) : ''}
    `, ({ name }) => submit({ ...(address ? { address } : {}), name: name.trim() }), pending ? 'Enregistrer' : 'Démarrer la capture');
  }

  function assignmentEditor(pending, profiles, submit, create, anonymous) {
    open('Attribuer la pesée', `<p>Pesée de <strong>${weight(pending.event)}</strong>.</p>
      <label for="assignment-profile">Profil</label><select id="assignment-profile" name="name" required>${option('', 'Choisir un profil', true)}${option('@anonymous', 'Sans profil enregistré')}${profiles.map(profile => option(profile.name, profile.name)).join('')}</select>
      <div class="actions">${button('Créer un profil', 'create-for-reading')}${button('Calculer sans profil', 'calculate-one-off')}</div>`,
    ({ name }) => submit({ id: pending.id, name: name === '@anonymous' ? null : name }), 'Confirmer');
    dialog.querySelector('[data-action="calculate-one-off"]').addEventListener('click', anonymous);
    dialog.querySelector('[data-action="create-for-reading"]').addEventListener('click', () => {
      try { create(); } catch (error) { onError(error); }
    });
  }

  function filterEditor(address, submit) {
    open('Filtrer par adresse Bluetooth', field('Adresse Bluetooth', 'address',
      `value="${e(address)}" placeholder="AA:BB:CC:DD:EE:FF" maxlength="36" required autofocus`),
    values => submit(values.address), 'Appliquer le filtre');
  }

  return { profileEditor, deviceEditor, assignmentEditor, filterEditor };
}
