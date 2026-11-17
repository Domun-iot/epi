import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetController } from '../src/dataset-controller.js';
const accountId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const summary = count => ({ count, from: count ? '2026-01-01T00:00:00.000Z' : null,
  to: count ? '2026-11-01T00:00:00.000Z' : null, hasData: count > 0 });
const free = { accountId, paid: false, paidUntil: null };
const pro = { accountId, paid: true, paidUntil: '2099-01-01T00:00:00.000Z' };
function setup({ existing = false, ready = false, localCount = 2, remoteCount = 3, choice = 'merge', hosted = false } = {}) {
  let context = { activeAccountId: null, datasetId: 'local', datasetGeneration: 0,
    accountModeEnabled: false, locked: false, localSummary: summary(localCount), syncReady: false };
  const calls = [];
  const backend = hosted ? { hosted: true } : {
    context: async () => context,
    prepare: async id => ({ ...context, accountExists: existing, syncReady: ready,
      accountSummary: summary(localCount) }),
    activate: async (id, mode, files, token, syncReady) => {
      calls.push({ id, mode, files, token, syncReady }); existing = true; ready ||= syncReady === true;
      context = { ...context, activeAccountId: id, datasetId: id, datasetGeneration: context.datasetGeneration + 1,
        accountModeEnabled: true, locked: false, syncReady: ready };
      return context;
    },
    logout: async () => context = { ...context, activeAccountId: null, datasetId: null, locked: true },
  };
  const choices = [], accesses = [], changes = [];
  const controller = createDatasetController({ backend,
    readRemote: async token => { calls.push({ remote: token }); return { accountId, files: [{ path: 'remote' }], summary: summary(remoteCount), revision: 'r1' }; },
    chooseData: async value => { choices.push(value); return typeof choice === 'function' ? choice(value) : choice; },
    change: async value => changes.push(value), access: value => accesses.push(value),
  });
  return { controller, calls, choices, accesses, changes };
}
test('FREE attachment stays local; first PRO use reviews the existing account dataset', async () => {
  const { controller, calls, choices } = setup();
  await controller.initialize();
  await controller.signIn(free, 'free-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'attach');
  assert.equal(controller.context.syncReady, false);
  await controller.signIn(pro, 'pro-token');
  assert.equal(choices.length, 1);
  assert.equal(calls.at(-1).mode, 'merge');
  assert.equal(calls.at(-1).syncReady, true);
  assert.equal(controller.context.syncReady, true);
});
test('cancelled merge changes neither storage nor binding', async () => {
  const { controller, calls } = setup({ choice: null });
  await controller.initialize();
  const binding = controller.capture();
  assert.equal(await controller.signIn(pro, 'token'), false);
  assert.equal(calls.filter(call => call.mode).length, 0);
  assert.equal(controller.isCurrent(binding), true);
});
test('remote-empty attachment is automatic and account switching never merges another account', async () => {
  const { controller, choices, calls } = setup({ remoteCount: 0 });
  await controller.initialize();
  await controller.signIn(pro, 'token');
  assert.equal(choices.length, 0);
  const previous = controller.capture();
  await controller.signIn({ ...free, accountId: secondId }, 'other-token');
  assert.equal(controller.isCurrent(previous), false);
  assert.equal(calls.at(-1).mode, 'existing');
  assert.equal(calls.at(-1).id, secondId);
});
test('native expiry keeps selected data, explicit logout locks it', async () => {
  const { controller } = setup();
  await controller.initialize();
  await controller.signIn(free, 'token');
  await controller.expire();
  assert.equal(controller.context.activeAccountId, accountId);
  assert.equal(controller.locked, false);
  await controller.signOut();
  assert.equal(controller.locked, true);
  assert.throws(() => controller.capture(), /dataset_locked/);
});
test('hosted boot and expiry always require online authentication', async () => {
  const { controller } = setup({ hosted: true });
  await controller.initialize();
  assert.equal(controller.locked, true);
  await controller.signIn(free, 'token');
  assert.equal(controller.locked, false);
  await controller.expire();
  assert.equal(controller.locked, true);
});
test('an external account change cancels a pending merge and invalidates old work', async () => {
  let resolve;
  const { controller, calls } = setup({ choice: () => new Promise(done => { resolve = done; }) });
  await controller.initialize();
  const binding = controller.capture();
  const signingIn = controller.signIn(pro, 'token');
  while (!resolve) await new Promise(done => setImmediate(done));
  controller.invalidate();
  resolve('merge');
  assert.equal(await signingIn, false);
  assert.equal(calls.some(call => call.mode), false);
  assert.equal(controller.isCurrent(binding), false);
  assert.equal(controller.locked, true);
});

test('a failed new dataset load remains locked and cannot reveal the old dataset', async () => {
  let selected;
  const controller = createDatasetController({
    backend: { hosted: true },
    access: () => {},
    change: async context => { if (!context.locked) { selected = context.datasetId; throw new Error('Read failed'); } },
  });
  await controller.initialize();
  await assert.rejects(controller.signIn(free, 'token'), /Read failed/);
  assert.equal(selected, accountId);
  assert.equal(controller.locked, true);
  assert.throws(() => controller.capture(), /dataset_locked/);
});

test('the reviewed bootstrap revision survives restart and stale work cannot clear it', async () => {
  let confirms = 0;
  let context = { activeAccountId: accountId, datasetId: accountId, datasetGeneration: 4,
    accountModeEnabled: true, syncReady: true, syncRevision: 'a'.repeat(64), locked: false };
  const controller = createDatasetController({ backend: {
    context: async () => context,
    confirmSync: async (id, generation) => { assert.equal(id, accountId); assert.equal(generation,4); confirms += 1; },
  }, change: async () => {}, access: () => {} });
  await controller.initialize();
  assert.equal(controller.revision, 'a'.repeat(64));
  const old = controller.capture();
  controller.invalidate();
  await controller.clearRevision(old);
  assert.equal(confirms,0);
  await controller.refresh();
  await controller.clearRevision(controller.capture());
  assert.equal(confirms,1);
  assert.equal(controller.revision,undefined);
});

test('explicit repair reads the complete same-account snapshot despite prior receipts without repeating the first-bind choice', async () => {
  const { controller, calls, choices, accesses } = setup({ existing: true, ready: true });
  await controller.initialize();
  await controller.signIn(pro, 'token');
  const before = controller.capture();
  assert.equal(calls.filter(call => call.remote).length,0);
  await controller.signIn(pro, 'token', { repair: true });
  assert.equal(calls.filter(call => call.remote).length,1);
  assert.equal(calls.at(-1).id,accountId);
  assert.equal(calls.at(-1).mode,'merge');
  assert.equal(choices.length,0);
  assert.equal(controller.isCurrent(before),false);
  assert.ok(accesses.some(access => access.pending && access.repairing));
});

test('cancellation during hosted initial load stays locked when the delayed load completes', async () => {
  let finishLoad;
  const accesses=[];
  const controller=createDatasetController({backend:{hosted:true},access:value=>accesses.push(value),
    change:context=>context.locked?undefined:new Promise(resolve=>{finishLoad=resolve;})});
  await controller.initialize();
  const login=controller.signIn(free,'token');
  while(!finishLoad)await new Promise(resolve=>setImmediate(resolve));
  controller.invalidate();
  finishLoad();
  assert.equal(await login,false);
  assert.equal(controller.locked,true);
  assert.equal(accesses.at(-1).locked,true);
});
