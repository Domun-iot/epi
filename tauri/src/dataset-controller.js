const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function createDatasetController({ backend, readRemote, chooseData, change, access }) {
  let context;
  let transition = false;
  let repairing = false;
  let revision;
  let epoch = 0;
  let intent = 0;
  let invalidated = false;
  let idle = Promise.resolve();
  let finishTransition = () => {};
  function begin() { idle = new Promise(resolve => { finishTransition = resolve; }); transition = true; }
  function finish() { const repaired = repairing; transition = false; repairing = false; finishTransition(); publish(repaired); }
  const hosted = backend.hosted === true;
  const empty = { count: 0, from: null, to: null, hasData: false };
  const locked = () => !context || context.locked || transition || invalidated;
  const publish = (repaired = false) => access({ locked: locked(), hosted, pending: transition, repairing, repaired });

  async function use(next, credentials) {
    context = next;
    const selectedEpoch = ++epoch;
    try { await change(next, credentials, selectedEpoch); if (epoch === selectedEpoch) invalidated = false; }
    catch (error) { invalidated = true; throw error; }
  }

  return {
    get context() { return context; },
    get epoch() { return epoch; },
    get locked() { return locked(); },
    get revision() { return revision; },
    async clearRevision(binding) {
      if (revision === undefined) return;
      if (binding && !this.isCurrent(binding)) return;
      const selected = this.capture();
      if (backend.confirmSync) await backend.confirmSync(context.activeAccountId, selected.datasetGeneration);
      if (this.isCurrent(selected)) { revision = undefined; delete context.syncRevision; }
    },
    capture() {
      if (locked()) throw Object.assign(new Error('dataset_locked'), { code: 'dataset_locked' });
      return { datasetId: context.datasetId, datasetGeneration: context.datasetGeneration, epoch };
    },
    isCurrent(binding) {
      return !locked() && binding?.epoch === epoch && binding.datasetId === context.datasetId;
    },
    invalidate() { intent += 1; epoch += 1; invalidated = true; access({ locked: true, hosted, pending: true, repairing: false }); },
    waitIdle() { return idle; },
    async initialize() {
      context = hosted ? { locked: true, activeAccountId: null, datasetId: null,
        accountModeEnabled: true, localSummary: empty } : await backend.context();
      revision = context.syncRevision;
      await use(context);
      publish();
      return context;
    },
    async signIn(info, token, { forceReview = false, repair = false } = {}) {
      const accountId = info?.accountId;
      if (!uuid.test(accountId ?? '')) throw new Error('invalid_account_id');
      if (transition) throw new Error('dataset_transition');
      const attempt = intent;
      repairing = repair && context?.activeAccountId === accountId && context?.syncReady === true;
      begin();
      publish();
      try {
        if (hosted) {
          await use({ activeAccountId: accountId, datasetId: accountId, accountModeEnabled: true,
            locked: false, localSummary: empty }, { info, token });
        } else {
          const prepared = await backend.prepare(accountId, token);
          let mode = prepared.accountExists ? (repair ? 'merge' : 'existing') : 'attach';
          let remoteFiles = [];
          let initialRevision;
          const reviewSync = info.paid === true && Date.parse(info.paidUntil) > Date.now() && (!prepared.syncReady || forceReview || repair);
          if (reviewSync) {
            const remote = await readRemote(token);
            if (remote.accountId !== accountId || !Array.isArray(remote.files)) throw new Error('invalid_dataset');
            const local = prepared.accountExists ? prepared.accountSummary : prepared.localSummary;
            const localHasData = local?.hasData ?? local?.count > 0;
            const remoteHasData = remote.summary.hasData ?? remote.summary.count > 0;
            if (remoteHasData && localHasData) {
              mode = repair ? 'merge' : await chooseData({ local, remote: remote.summary });
              if (!mode) return false;
            } else if (remoteHasData) mode = repair ? 'merge' : 'remote';
            else if (remote.files.length && !prepared.accountExists) mode = 'merge';
            remoteFiles = ['merge', 'remote'].includes(mode) ? remote.files : [];
            initialRevision = remote.revision;
          }
          if (attempt !== intent) return false;
          const next = await backend.activate(accountId, mode, remoteFiles, token, reviewSync ? true : undefined, initialRevision);
          if (attempt !== intent) return false;
          revision = next.syncRevision ?? initialRevision;
          await use(next, { info, token, repair: repairing });
        }
        if (attempt !== intent) { invalidated = true; return false; }
        return true;
      } finally { finish(); }
    },
    async signOut() {
      if (transition) throw new Error('dataset_transition');
      begin();
      publish();
      try {
        revision = undefined;
        await use(hosted ? { locked: true, activeAccountId: null, datasetId: null,
          accountModeEnabled: true, localSummary: empty } : await backend.logout());
      } finally { finish(); }
    },
    async expire() {
      if (hosted) { this.invalidate(); await idle; await this.signOut(); }
      // An expired online token never deselects a native/local dataset.
    },
    async refresh() {
      if (hosted) return;
      begin();
      publish();
      try {
        const next = await backend.context();
        revision = next.syncRevision;
        await use(next);
      }
      finally { finish(); }
    },
  };
}
