'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { parseArgs } = require('node:util');
const { createReceiver } = require('./scale.cjs');

const { prepareProfile, profileAt } = require('./profiles.cjs');
const { formatComposition } = require('./composition.cjs');
const { profileDirectory: directory, readMeasurements, writeMeasurement } = require('./storage.cjs');
const { listDevices, selectDevice, findDevice, askDeviceName, registerDevice, parseDeviceMetadata, updateDeviceMetadata } = require('./devices.cjs');
const { chooseProfile, listProfiles } = require('./profile-choice.cjs');
const { bufferHistory, historyRecord, latestWeights, matchWeight } = require('./history.cjs');

function showHelp(output = console.log) {
  output('Usage : node index.cjs [NOM] [--mac AA:BB:CC:DD:EE:FF] [--raw] [--seconds N]');
  output('  -u, --user, --utilisateur NOM');
  output('  -s, --sex, --sexe H|F');
  output('  -a, --age, --âge ANNÉES');
  output('  -b, -n, --birthdate, --birthday, --birth, --naissance JJ/MM/AAAA');
  output('  -t, --height, --taille CM');
  output('  -d, --device, --appareil NOM');
  output('  --identify [--mac ADRESSE] Inspecte les annonces Bluetooth');
  output('  -h, --help, --aide Affiche cette aide');
}

function cliValues() {
  const { tokens } = parseArgs({ tokens: true, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    aide: { type: 'boolean' },
    raw: { type: 'boolean' },
    identify: { type: 'boolean' },
    mac: { type: 'string' },
    device: { type: 'string', short: 'd' },
    appareil: { type: 'string' },
    seconds: { type: 'string' },
    utilisateur: { type: 'string', short: 'u' },
    user: { type: 'string' },
    sexe: { type: 'string', short: 's' },
    sex: { type: 'string' },
    age: { type: 'string', short: 'a' },
    âge: { type: 'string' },
    naissance: { type: 'string', short: 'n' },
    birthdate: { type: 'string', short: 'b' },
    birthday: { type: 'string' },
    birth: { type: 'string' },
    taille: { type: 'string', short: 't' },
    height: { type: 'string' },
  } });
  const aliases = new Map([['user', 'utilisateur'], ['sex', 'sexe'], ['âge', 'age'], ['height', 'taille'],
    ['appareil', 'device'], ['birthdate', 'naissance'], ['birthday', 'naissance'], ['birth', 'naissance']]);
  const values = Object.create(null);
  for (const token of tokens) {
    if (token.kind === 'option') values[aliases.get(token.name) ?? token.name] = token.value ?? true;
    if (token.kind === 'positional') {
      if (values.positional !== undefined) throw Error('Un seul nom de profil peut être passé sans option.');
      values.positional = token.value;
    }
  }
  if (values.positional !== undefined && values.utilisateur !== undefined) {
    throw Error('Indique le nom soit seul, soit avec --utilisateur.');
  }
  values.utilisateur ??= values.positional;
  return values;
}

async function main() {
  let values;
  try { values = cliValues(); }
  catch (error) {
    console.error(error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'Option inconnue. ' + error.message : error.message);
    showHelp(console.error);
    process.exitCode = 1;
    return;
  }
  if (values.help || values.aide) return showHelp();
  if (process.platform !== 'win32') throw Error('Ce scanner nécessite Windows.');
  const mac = values.mac?.toUpperCase();
  if (mac !== undefined && !/^([A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(mac)) {
    throw Error('Adresse invalide ; format attendu : AA:BB:CC:DD:EE:FF.');
  }
  const seconds = values.seconds === undefined ? (values.identify ? 20 : null) : Number(values.seconds);
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)) {
    throw Error('--seconds doit être un entier entre 1 et 86400.');
  }

  const profiles = values.identify ? [] : await listProfiles(directory);
  const hasDetails = ['sexe', 'age', 'taille', 'naissance'].some(key => values[key] !== undefined);
  const devices = values.identify ? [] : listDevices();
  const { existing, enroll } = selectDevice(devices, values.device);
  if (existing && mac && existing.bluetooth.address !== mac) throw Error('--mac ne correspond pas à l’appareil sélectionné.');
  if (enroll) console.error('Pour enregistrer « ' + enroll + ' », utilise uniquement la nouvelle balance pendant l’écoute.');
  const acceptAddress = address => existing ? existing.bluetooth.address === address
    : !enroll || !findDevice({ address }, devices);
  const latest = latestWeights(values.identify || values.utilisateur !== undefined || hasDetails ? [] : readMeasurements());
  const work = mkdtempSync(join(tmpdir(), 'balance-xiaomi-'));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  let child;
  try {
    const windows = process.env.WINDIR || 'C:\\Windows';
    const framework = join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const meta = join(windows, 'System32', 'WinMetadata');
    const exe = join(work, 'scanner.exe');
    const refs = [
      ...['System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.Runtime.WindowsRuntime']
        .map(name => join(framework, name + '.dll')),
      ...['Windows.Devices', 'Windows.Storage', 'Windows.Foundation']
        .map(name => join(meta, name + '.winmd')),
    ];
    const result = spawnSync(join(framework, 'csc.exe'), [
      '/nologo', '/out:' + exe, ...refs.map(ref => '/reference:' + ref), join(__dirname, 'scan.cs'),
    ], { stdio: ['ignore', 2, 2], windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('La compilation du lecteur Bluetooth Windows a échoué.');
    const scannerArgs = values.identify ? ['--identify', mac?.replace(/:/g, '') ?? '']
      : [(existing?.bluetooth.address ?? mac ?? '').replace(/:/g, ''),
        ...(enroll ? devices.map(device => device.bluetooth.address.replace(/:/g, '')) : [])];
    child = spawn(exe, scannerArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    cleanup();
    throw error;
  }

  const receive = createReceiver({ mac, acceptAddress, raw: values.raw, includeHex: true });
  const receiveStable = values.raw ? createReceiver({ mac, acceptAddress, includeHex: true }) : receive;
  let stopping = false;
  let timer;
  let force;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    force = setTimeout(() => child.kill(), 3000);
    force.unref();
  };
  const metadataByAddress = new Map();
  let saving = false;
  let measurementAddress;
  let saveQueue = Promise.resolve();
  const saveHistory = bufferHistory(event => {
    saving = true;
    measurementAddress = event.address;
    saveQueue = saveQueue.then(async () => {
      if (historyFailed) return;
      let device = findDevice(event, devices);
      if (!device) {
        const name = enroll ?? await askDeviceName(event, devices);
        device = registerDevice(name, event, undefined, metadataByAddress.get(event.address));
        devices.push(device);
        console.error(`Appareil enregistré : ${device.name} (${event.address})`);
      }
      const selected = values.utilisateur === undefined ? null
        : await chooseProfile(profiles, values.utilisateur, { allowNew: Boolean(process.stdin.isTTY) || hasDetails });
      let assigned = await prepareProfile({ ...values, utilisateur: selected?.name },
        { directory, filename: selected?.file });
      if (!assigned) {
        let chosen = matchWeight(event, profiles, latest);
        if (chosen) console.error(`Profil attribué par le poids : ${chosen.name}`);
        else {
          console.error(`Aucun poids de référence compatible pour ${event.weight} ${event.unit}.`);
          chosen = await chooseProfile(profiles, undefined, { allowNew: true });
        }
        assigned = await prepareProfile({ utilisateur: chosen.name }, { directory, filename: chosen.file });
      }
      // A scan response can follow the measurement advertisement.
      await new Promise(resolve => setTimeout(resolve, 350));
      const record = historyRecord(event, assigned, device);
      writeMeasurement(record);
      for (const [key, row] of latestWeights([record])) {
        if (!latest.has(key) || row.receivedAt >= latest.get(key).receivedAt) latest.set(key, row);
      }
      if (!values.raw) console.log(formatComposition(event, profileAt(assigned, event.receivedAt)));
      stop();
    }).catch(error => {
      historyFailed = true;
      console.error(`Pesée non enregistrée (${error.message}).`);
      process.exitCode = 1;
      stop();
    });
  });
  let historyFailed = false;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.stdin.on('error', () => {}); // The scanner may already have exited.
  child.stderr.setEncoding('utf8');
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; process.stderr.write(chunk); });
  createInterface({ input: child.stdout }).on('line', line => {
    if (line === 'READY') {
      console.error(values.identify ? 'Écoute ciblée active. Réveille la balance.'
        : 'Écoute Bluetooth active. Monte sur la balance pour enregistrer une pesée.');
      if (seconds !== null) timer = setTimeout(stop, seconds * 1000);
      return;
    }
    if (values.identify) {
      if (line.startsWith('IDENT ')) console.log(line);
      else {
        const measurement = receiveStable(line);
        if (measurement) console.log('MESURE ' + JSON.stringify(measurement));
      }
      return;
    }
    if (line.startsWith('META ')) {
      const metadata = parseDeviceMetadata(line);
      if (metadata && (metadata.address === measurementAddress || acceptAddress(metadata.address)) && (!mac || metadata.address === mac)) {
        const device = findDevice(metadata, devices);
        if (device) {
          try { updateDeviceMetadata(device, metadata); }
          catch (error) { console.error(`Fiche de ${device.name} non mise à jour (${error.message}).`); }
        } else {
          const { address, ...fields } = metadata;
          if (!metadataByAddress.has(address) && metadataByAddress.size >= 256) {
            metadataByAddress.delete(metadataByAddress.keys().next().value);
          }
          metadataByAddress.set(address, { ...metadataByAddress.get(address), ...fields });
        }
      }
      return;
    }
    const event = receive(line);
    const stable = values.raw ? receiveStable(line) : event;
    if (stable && !stopping && !saving) {
      const name = findDevice(stable, devices)?.name ?? stable.address;
      const impedance = stable.impedanceOhms > 0 ? ` et une impédance de ${stable.impedanceOhms} Ω` : '';
      console.error(`L’appareil ${name} a reçu un poids de ${stable.weight} ${stable.unit}${impedance}.`);
      saveHistory(stable);
    }
    if (event && values.raw) console.log(JSON.stringify(event));
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    clearTimeout(force);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    cleanup();
    if (!stopping && (code !== 0 || signal)) {
      process.exitCode = 1;
      if (/DisabledByUser|RadioNotAvailable/.test(errors)) {
        console.error('Vérifie que le Bluetooth est activé dans Paramètres → Bluetooth et appareils.');
      } else if (!errors) {
        console.error('Le lecteur Bluetooth s’est arrêté de façon inattendue.');
      }
    }
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
