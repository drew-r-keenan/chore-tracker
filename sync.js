// sync.js — optional Firebase Firestore cloud sync. Lazy-loaded only when enabled.
// Model: one document at households/{code}. Anonymous auth. Append-only log unions
// across devices; everything else is last-write-wins by meta.updatedAt.

import { store } from './store.js';
import { migrate } from './lib.js';

const FB_VERSION = '10.12.2';
let fb = null; // loaded SDK handles

async function loadSDK() {
  if (fb) return fb;
  const appMod = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-app.js`);
  const authMod = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-auth.js`);
  const fsMod = await import(`https://www.gstatic.com/firebasejs/${FB_VERSION}/firebase-firestore.js`);
  fb = {
    initializeApp: appMod.initializeApp,
    getApps: appMod.getApps,
    getApp: appMod.getApp,
    getAuth: authMod.getAuth,
    signInAnonymously: authMod.signInAnonymously,
    onAuthStateChanged: authMod.onAuthStateChanged,
    getFirestore: fsMod.getFirestore,
    doc: fsMod.doc,
    getDoc: fsMod.getDoc,
    setDoc: fsMod.setDoc,
    onSnapshot: fsMod.onSnapshot,
  };
  return fb;
}

/* Pure: merge a remote doc into local. Log entries union (tombstones win); the rest is LWW. */
export function mergeStates(local, remote) {
  if (!remote) return local;
  if (!local) return migrate(remote);
  const preferRemote = (remote.meta?.updatedAt || 0) >= (local.meta?.updatedAt || 0);
  const primary = preferRemote ? remote : local;
  const secondary = preferRemote ? local : remote;
  return migrate({
    schemaVersion: Math.max(local.schemaVersion || 1, remote.schemaVersion || 1),
    people: { ...secondary.people, ...primary.people },
    chores: { ...secondary.chores, ...primary.chores },
    weekMeta: { ...secondary.weekMeta, ...primary.weekMeta },
    settings: { ...secondary.settings, ...primary.settings },
    log: mergeLog(local.log || {}, remote.log || {}),
    meta: { ...primary.meta },
  });
}
function mergeLog(a, b) {
  const out = {};
  for (const [id, e] of Object.entries(a)) out[id] = e;
  for (const [id, e] of Object.entries(b)) {
    if (!out[id]) { out[id] = e; continue; }
    const deleted = !!(out[id].deleted || e.deleted);
    out[id] = { ...out[id], deleted, deletedAt: out[id].deletedAt || e.deletedAt };
  }
  return out;
}

/* Pairing deep-link helpers (firebaseConfig apiKey is a public identifier, safe to embed). */
export function encodePair(config, code) {
  try { return btoa(encodeURIComponent(JSON.stringify({ config, code }))); }
  catch { return ''; }
}
export function decodePair(str) {
  try { return JSON.parse(decodeURIComponent(atob(str))); }
  catch { return null; }
}

export const sync = {
  status: 'off',          // off | connecting | connected | error
  error: null,
  _unsub: null,
  _ref: null,
  _pushTimer: null,
  _listeners: new Set(),

  onStatus(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); },
  _emit() { for (const cb of this._listeners) cb(this.status, this.error); },
  _set(status, error = null) { this.status = status; this.error = error; this._emit(); },

  isEnabled() { return store.device.sync && store.device.sync.enabled; },

  // Probe an existing household without committing. Returns { exists, remote }.
  async probe(config, code) {
    const k = await loadSDK();
    const appName = 'ct-' + Math.abs(hashStr(JSON.stringify(config))).toString(36);
    const app = k.getApps().find((a) => a.name === appName) || k.initializeApp(config, appName);
    const auth = k.getAuth(app);
    await k.signInAnonymously(auth);
    const db = k.getFirestore(app);
    const ref = k.doc(db, 'households', code);
    const snap = await k.getDoc(ref);
    this._pending = { app, db, ref };
    return { exists: snap.exists(), remote: snap.exists() ? snap.data() : null };
  },

  // Commit a connection chosen by the user. choice: 'cloud' | 'local' | 'merge'.
  async connect(config, code, choice = 'merge', remote = null) {
    try {
      this._set('connecting');
      const k = await loadSDK();
      let app, db, ref;
      if (this._pending) { ({ app, db, ref } = this._pending); this._pending = null; }
      else {
        const appName = 'ct-' + Math.abs(hashStr(JSON.stringify(config))).toString(36);
        app = k.getApps().find((a) => a.name === appName) || k.initializeApp(config, appName);
        await k.signInAnonymously(k.getAuth(app));
        db = k.getFirestore(app);
        ref = k.doc(db, 'households', code);
        if (remote === null) { const s = await k.getDoc(ref); remote = s.exists() ? s.data() : null; }
      }
      this._ref = ref;

      if (remote) {
        if (choice === 'cloud') store.setStateFromRemote(remote);
        else if (choice === 'local') { /* keep local, will overwrite cloud on push */ }
        else store.setStateFromRemote(mergeStates(store.state, remote));
      }

      store.mutateDevice((d) => { d.sync = { enabled: true, code, config }; });
      await this._push(true); // ensure cloud has current state (creates doc if absent)
      this._subscribe(k);
      store._onLocalChange = () => this._schedulePush();
      this._set('connected');
      return { ok: true };
    } catch (e) {
      this._set('error', friendlyErr(e));
      return { ok: false, error: friendlyErr(e) };
    }
  },

  // Re-establish a previously-saved connection on app load.
  async resume() {
    const s = store.device.sync;
    if (!s || !s.enabled || !s.config || !s.code) return;
    try {
      this._set('connecting');
      const k = await loadSDK();
      const appName = 'ct-' + Math.abs(hashStr(JSON.stringify(s.config))).toString(36);
      const app = k.getApps().find((a) => a.name === appName) || k.initializeApp(s.config, appName);
      await k.signInAnonymously(k.getAuth(app));
      const db = k.getFirestore(app);
      this._ref = k.doc(db, 'households', s.code);
      const snap = await k.getDoc(this._ref);
      if (snap.exists()) store.setStateFromRemote(mergeStates(store.state, snap.data()));
      await this._push(true);
      this._subscribe(k);
      store._onLocalChange = () => this._schedulePush();
      this._set('connected');
    } catch (e) {
      this._set('error', friendlyErr(e));
    }
  },

  _subscribe(k) {
    if (this._unsub) this._unsub();
    this._unsub = k.onSnapshot(this._ref, (snap) => {
      if (!snap.exists()) return;
      if (snap.metadata.hasPendingWrites) return;       // our optimistic write
      const remote = snap.data();
      if (remote.meta?.updatedBy === store.device.deviceId) return; // our echo
      store.setStateFromRemote(mergeStates(store.state, remote));
    }, (err) => this._set('error', friendlyErr(err)));
  },

  _schedulePush() {
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._push(), 450);
  },
  async _push(immediate = false) {
    if (!this._ref || !fb) return;
    try {
      await fb.setDoc(this._ref, JSON.parse(JSON.stringify(store.state)), { merge: true });
      if (this.status === 'error') this._set('connected');
    } catch (e) {
      if (immediate) throw e;
      this._set('error', friendlyErr(e));
    }
  },

  disable() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    clearTimeout(this._pushTimer);
    this._ref = null;
    store._onLocalChange = null;
    store.mutateDevice((d) => { d.sync = { enabled: false, code: null, config: null }; });
    this._set('off');
  },
};

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
function friendlyErr(e) {
  const m = (e && (e.code || e.message)) || String(e);
  if (/permission-denied/i.test(m)) return 'Permission denied — check your Firestore security rules and that Anonymous auth is enabled.';
  if (/auth\//i.test(m) || /configuration-not-found/i.test(m)) return 'Auth failed — enable Anonymous sign-in in Firebase (Authentication → Sign-in method).';
  if (/invalid-api-key|api-key/i.test(m)) return 'Invalid Firebase config — double-check the pasted config object.';
  if (/offline|unavailable|network/i.test(m)) return 'Network unavailable — will retry when back online.';
  return 'Sync error: ' + m;
}
