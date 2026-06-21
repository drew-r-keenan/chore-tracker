// store.js — persistence + state container. Local-first with in-memory fallback.
// Synced state lives under STATE_KEY. Device-only prefs (theme, sound, sync config,
// celebration latches) live under DEVICE_KEY and are NEVER synced.

import { defaultState, migrate, uid } from './lib.js';

const STATE_KEY = 'choretracker:v1';
const DEVICE_KEY = 'choretracker:device';

let storageOK = true;
let memFallback = {};

function probeStorage() {
  try {
    const k = '__ct_probe__';
    localStorage.setItem(k, '1');
    localStorage.getItem(k);
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

function rawGet(key) {
  if (storageOK) {
    try { return localStorage.getItem(key); } catch { storageOK = false; }
  }
  return key in memFallback ? memFallback[key] : null;
}
function rawSet(key, val) {
  if (storageOK) {
    try { localStorage.setItem(key, val); return { ok: true }; }
    catch (e) {
      if (e && e.name === 'QuotaExceededError') return { ok: false, reason: 'quota' };
      storageOK = false; // private mode etc.
    }
  }
  memFallback[key] = val;
  return { ok: true, memory: true };
}

const defaultDevice = () => ({
  deviceId: uid('d_'),
  theme: 'system',     // 'system' | 'light' | 'dark'
  sound: false,
  seenBadges: [],
  celebratedWeeks: [],
  sync: { enabled: false, code: null, config: null },
});

export const store = {
  state: null,
  device: null,
  storageHealthy: true,
  _subs: new Set(),
  _onLocalChange: null, // set by sync layer: called after a user-driven mutation

  init() {
    storageOK = probeStorage();
    this.storageHealthy = storageOK;

    // device prefs
    let dev = null;
    try { dev = JSON.parse(rawGet(DEVICE_KEY)); } catch { dev = null; }
    this.device = Object.assign(defaultDevice(), dev || {});
    if (!dev) this._persistDevice();

    // synced state
    let st = null, corrupt = false;
    const rawState = rawGet(STATE_KEY);
    if (rawState) {
      try { st = JSON.parse(rawState); }
      catch { corrupt = true; this._corruptBackup = rawState; }
    }
    this.state = migrate(st || defaultState());
    if (!rawState || corrupt) this._persistState();
    return { firstRun: !rawState, corrupt };
  },

  subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); },
  _emit() { for (const cb of this._subs) cb(this.state); },

  _persistState() {
    const res = rawSet(STATE_KEY, JSON.stringify(this.state));
    this.storageHealthy = storageOK && res.ok;
    return res;
  },
  _persistDevice() { rawSet(DEVICE_KEY, JSON.stringify(this.device)); },

  // User-driven mutation: bump meta, persist, notify subscribers, and trigger sync push.
  mutate(fn) {
    fn(this.state);
    this.state.meta = this.state.meta || {};
    this.state.meta.updatedAt = Date.now();
    this.state.meta.updatedBy = this.device.deviceId;
    this.state.meta.rev = (this.state.meta.rev || 0) + 1;
    const res = this._persistState();
    this._emit();
    if (this._onLocalChange) this._onLocalChange(this.state);
    return res;
  },

  // Device prefs mutation (not synced).
  mutateDevice(fn) {
    fn(this.device);
    this._persistDevice();
    this._emit();
  },

  // Replace synced state from a remote sync snapshot WITHOUT echoing back to sync.
  setStateFromRemote(next) {
    this.state = migrate(next);
    this._persistState();
    this._emit();
  },

  // device-local celebration latches
  hasCelebratedWeek(weekKey) { return this.device.celebratedWeeks.includes(weekKey); },
  markWeekCelebrated(weekKey) {
    if (!this.device.celebratedWeeks.includes(weekKey)) {
      this.device.celebratedWeeks.push(weekKey);
      this._persistDevice();
    }
  },
  unmarkWeekCelebrated(weekKey) {
    this.device.celebratedWeeks = this.device.celebratedWeeks.filter((w) => w !== weekKey);
    this._persistDevice();
  },
  newlySeenBadges(currentEarnedSet) {
    const seen = new Set(this.device.seenBadges);
    const fresh = [];
    for (const token of currentEarnedSet) if (!seen.has(token)) fresh.push(token);
    if (fresh.length) {
      this.device.seenBadges = Array.from(currentEarnedSet);
      this._persistDevice();
    } else {
      // keep seen in sync with current earned (handles undo lowering the set)
      this.device.seenBadges = Array.from(currentEarnedSet);
      this._persistDevice();
    }
    return fresh;
  },
};
