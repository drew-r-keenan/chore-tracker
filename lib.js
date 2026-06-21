// lib.js — pure model logic: defaults, week math, selectors, gamification, badges.
// No DOM access here. Everything is derived from an append-only completion log.

export const SCHEMA_VERSION = 1;

export const PLAYER_COLORS = [
  '#2BA29A', '#E86F5C', '#7C6FE8', '#E8954A',
  '#3B82C4', '#D2548F', '#5AA84B', '#C9A227',
];

export const WEIGHT_TIERS = [
  { value: 1, label: 'Quick',    hint: 'under 5 min' },
  { value: 2, label: 'Standard', hint: 'everyday task' },
  { value: 3, label: 'Effort',   hint: 'takes a while' },
  { value: 4, label: 'Big',      hint: 'real work' },
  { value: 5, label: 'Dreaded',  hint: 'the worst' },
];

const SEED_CHORES = [
  { name: 'Dishes',           weight: 2, icon: '🍽️' },
  { name: 'Cook dinner',      weight: 3, icon: '🍳' },
  { name: 'Take out trash',   weight: 1, icon: '🗑️' },
  { name: 'Laundry',          weight: 3, icon: '🧺' },
  { name: 'Vacuum',           weight: 3, icon: '🧹' },
  { name: 'Clean bathroom',   weight: 4, icon: '🛁' },
  { name: 'Grocery shopping', weight: 3, icon: '🛒' },
  { name: 'Make bed',         weight: 1, icon: '🛏️' },
  { name: 'Wipe counters',    weight: 1, icon: '🧽' },
  { name: 'Feed / walk pet',  weight: 1, icon: '🐾' },
];

export function uid(prefix = '') {
  const r = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.floor(performance.now() * 1000));
  return prefix + r;
}

export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function defaultState(now = Date.now()) {
  const chores = {};
  SEED_CHORES.forEach((c, i) => {
    const id = uid('c_');
    chores[id] = {
      id, name: c.name, weight: c.weight, icon: c.icon,
      assignee: 'either', active: true, seed: true, order: i, createdAt: now,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    people: {
      p1: { id: 'p1', name: 'Drew',    emoji: '🦊', color: PLAYER_COLORS[0] },
      p2: { id: 'p2', name: 'Partner', emoji: '🐼', color: PLAYER_COLORS[1] },
    },
    chores,
    log: {},          // id -> { id, choreId, choreName, icon, personId, points, doneAt, weekKey, deleted? }
    weekMeta: {},     // weekKey -> { goal, goalMode }  (frozen the first time a week gets a completion)
    settings: {
      weeklyGoal: 40,
      goalMode: 'combined',  // 'combined' | 'perPerson'
      weekStartsOn: 1,       // 0=Sun .. 6=Sat (Monday default)
      timeZone: deviceTimeZone(),
    },
    meta: { updatedAt: now, updatedBy: 'seed', rev: 0 },
  };
}

// Forward-only migration runner. Currently only v1 exists, but the scaffold is here.
export function migrate(state) {
  if (!state || typeof state !== 'object') return defaultState();
  let s = state;
  if (typeof s.schemaVersion !== 'number') s.schemaVersion = 1;
  // future: while (s.schemaVersion < SCHEMA_VERSION) { ... ; s.schemaVersion++ }
  // Defensive backfill of any missing top-level keys.
  const d = defaultState();
  s.people = s.people || d.people;
  s.chores = s.chores || {};
  s.log = s.log || {};
  s.weekMeta = s.weekMeta || {};
  s.settings = Object.assign({}, d.settings, s.settings || {});
  s.meta = Object.assign({}, d.meta, s.meta || {});
  if (!s.settings.timeZone) s.settings.timeZone = deviceTimeZone();
  return s;
}

/* ----------------------------- week math ----------------------------- */
// Resolve an epoch ms into the YYYY-MM-DD *calendar date* in a given IANA zone.
export function localYMD(epochMs, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochMs));
  }
}

function ymdParts(ymd) { const [y, m, d] = ymd.split('-').map(Number); return { y, m, d }; }
// Day of week (0=Sun) of a calendar date, computed purely (DST-safe).
function dowOfYMD(ymd) { const { y, m, d } = ymdParts(ymd); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function addDaysYMD(ymd, n) {
  const { y, m, d } = ymdParts(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
// The week-start calendar date for a given date + configured start day.
export function weekStartOfYMD(ymd, weekStartsOn) {
  const dow = dowOfYMD(ymd);
  const diff = (dow - weekStartsOn + 7) % 7;
  return addDaysYMD(ymd, -diff);
}
// weekKey == the week-start calendar date string (e.g. '2026-06-15'). Frozen onto each completion.
export function weekKeyFor(epochMs, settings) {
  return weekStartOfYMD(localYMD(epochMs, settings.timeZone), settings.weekStartsOn);
}
export function currentWeekKey(settings, now = Date.now()) { return weekKeyFor(now, settings); }
export function shiftWeekKey(weekKey, deltaWeeks) { return addDaysYMD(weekKey, deltaWeeks * 7); }

export function weekRangeLabel(weekKey) {
  const end = addDaysYMD(weekKey, 6);
  const s = ymdParts(weekKey), e = ymdParts(end);
  const fmt = (p) => new Date(Date.UTC(p.y, p.m - 1, p.d));
  const mo = (dt) => dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = (dt) => dt.getUTCDate();
  const sd = fmt(s), ed = fmt(e);
  if (s.m === e.m) return `${mo(sd)} ${day(sd)} – ${day(ed)}`;
  return `${mo(sd)} ${day(sd)} – ${mo(ed)} ${day(ed)}`;
}

/* ----------------------------- selectors ----------------------------- */
export function activeLog(state) {
  return Object.values(state.log).filter((e) => e && !e.deleted);
}
export function weekCompletions(state, weekKey) {
  return activeLog(state).filter((e) => e.weekKey === weekKey).sort((a, b) => b.doneAt - a.doneAt);
}
export function goalForWeek(state, weekKey) {
  const m = state.weekMeta[weekKey];
  return m && typeof m.goal === 'number' ? m.goal : state.settings.weeklyGoal;
}
export function goalModeForWeek(state, weekKey) {
  const m = state.weekMeta[weekKey];
  return m && m.goalMode ? m.goalMode : state.settings.goalMode;
}

export function weekStats(state, weekKey) {
  const comps = weekCompletions(state, weekKey);
  const byPerson = { p1: 0, p2: 0 };
  for (const e of comps) byPerson[e.personId] = (byPerson[e.personId] || 0) + e.points;
  const total = byPerson.p1 + byPerson.p2;
  const goal = goalForWeek(state, weekKey);
  const mode = goalModeForWeek(state, weekKey);
  let met;
  if (mode === 'perPerson') {
    const per = Math.ceil(goal / 2);
    met = byPerson.p1 >= per && byPerson.p2 >= per;
  } else {
    met = total >= goal;
  }
  return { weekKey, byPerson, total, goal, mode, met, count: comps.length, comps };
}

export function lifetimeXP(state) {
  return activeLog(state).reduce((s, e) => s + e.points, 0);
}

const LEVEL_NAMES = [
  [1, 'Roommates'], [3, 'Housemates'], [5, 'Domestic Duo'], [8, 'Home Heroes'],
  [12, 'House Champions'], [16, 'House Legends'], [20, 'Home CEOs'], [30, 'Household Royalty'],
];
function levelName(level) {
  let name = 'Roommates';
  for (const [min, n] of LEVEL_NAMES) if (level >= min) name = n;
  return name;
}
// Cumulative XP needed to reach level L (L>=1): T(L-1) where T(k)=25*k*(k+1). Level 1 starts at 0.
function xpThreshold(level) { const k = level - 1; return 25 * k * (k + 1); }
export function levelInfo(xp) {
  let level = 1;
  while (xpThreshold(level + 1) <= xp) level++;
  const base = xpThreshold(level);
  const next = xpThreshold(level + 1);
  const intoLevel = xp - base;
  const span = next - base;
  return { level, name: levelName(level), xp, intoLevel, span, toNext: next - xp, pct: span ? Math.min(100, (intoLevel / span) * 100) : 100 };
}

// Shared weekly-goal streak. Counts back from the most recently *completed* week.
// One "grace" week (missed by <10%) is allowed to hold the streak without breaking it.
export function goalStreak(state, now = Date.now()) {
  const cur = currentWeekKey(state.settings, now);
  let wk = shiftWeekKey(cur, -1); // start from last completed week
  let streak = 0, usedGrace = false, scanned = 0;
  while (scanned < 200) {
    scanned++;
    const st = weekStats(state, wk);
    if (st.met) { streak++; }
    else if (!usedGrace && st.total >= st.goal * 0.9 && st.total > 0) { usedGrace = true; /* holds, no increment */ }
    else break;
    wk = shiftWeekKey(wk, -1);
  }
  // Bonus: include the current week if it's already met.
  const curMet = weekStats(state, cur).met;
  return { weeks: streak, includesCurrent: curMet, display: curMet ? streak + 1 : streak };
}

// List of week keys (most recent first) that have any activity, plus current week.
export function activeWeekKeys(state, now = Date.now()) {
  const set = new Set(activeLog(state).map((e) => e.weekKey));
  set.add(currentWeekKey(state.settings, now));
  return Array.from(set).sort().reverse();
}

export function perChoreTotals(state, weekKeys) {
  const within = new Set(weekKeys);
  const rows = {}; // choreName -> {name, icon, p1, p2, total}
  for (const e of activeLog(state)) {
    if (within.size && !within.has(e.weekKey)) continue;
    const key = e.choreName || e.choreId;
    if (!rows[key]) rows[key] = { name: e.choreName || 'Chore', icon: e.icon || '✅', p1: 0, p2: 0, total: 0 };
    rows[key][e.personId] += e.points;
    rows[key].total += e.points;
  }
  return Object.values(rows).sort((a, b) => b.total - a.total);
}

/* ----------------------------- badges ----------------------------- */
// Each badge derives purely from state. scope 'household' or 'person'.
export const BADGES = [
  { id: 'first-blood',    name: 'First Blood',     emoji: '🩸', scope: 'person',    desc: 'Log your first chore.' },
  { id: 'centurion',      name: 'Centurion',       emoji: '💯', scope: 'person',    desc: 'Earn 100 lifetime points.' },
  { id: 'heavy-lifter',   name: 'Heavy Lifter',    emoji: '🏋️', scope: 'person',    desc: 'Complete a Dreaded (5-pt) chore.' },
  { id: 'early-bird',     name: 'Early Bird',      emoji: '🌅', scope: 'person',    desc: 'Log a chore before 9am.' },
  { id: 'weekend-warrior',name: 'Weekend Warrior', emoji: '⚔️', scope: 'person',    desc: 'Log 3+ chores on a Sat or Sun.' },
  { id: 'grinder',        name: 'Grinder',         emoji: '⚙️', scope: 'person',    desc: 'Log 5 chores in a single day.' },
  { id: 'setup-star',     name: 'Setup Star',      emoji: '⭐', scope: 'household', desc: 'Name both people & add a custom chore.' },
  { id: 'goal-crushers',  name: 'Goal Crushers',   emoji: '🚀', scope: 'household', desc: 'Beat the weekly goal by 50%+.' },
  { id: 'balanced-week',  name: 'Balanced Week',   emoji: '⚖️', scope: 'household', desc: 'Finish a goal-met week split 40–60%.' },
  { id: 'on-a-roll',      name: 'On a Roll',       emoji: '🔥', scope: 'household', desc: 'Hit your goal 3 weeks running.' },
  { id: 'unstoppable',    name: 'Unstoppable',     emoji: '🌋', scope: 'household', desc: 'Hit your goal 8 weeks running.' },
  { id: 'comeback',       name: 'Comeback',        emoji: '↩️', scope: 'household', desc: 'Hit goal the week after a miss.' },
  { id: 'perfect-pair',   name: 'Perfect Pair',    emoji: '💞', scope: 'household', desc: '4 balanced, goal-met weeks in a row.' },
  { id: 'century-team',   name: 'Power Couple',    emoji: '👑', scope: 'household', desc: 'Earn 500 lifetime points together.' },
];

// Returns a Set of earned tokens: 'badgeId' for household, 'badgeId:personId' for person.
export function earnedBadges(state, now = Date.now()) {
  const earned = new Set();
  const log = activeLog(state);
  const add = (id, person) => earned.add(person ? `${id}:${person}` : id);

  const perPerson = { p1: [], p2: [] };
  for (const e of log) (perPerson[e.personId] || (perPerson[e.personId] = [])).push(e);

  for (const pid of ['p1', 'p2']) {
    const evs = perPerson[pid] || [];
    if (evs.length) add('first-blood', pid);
    if (evs.reduce((s, e) => s + e.points, 0) >= 100) add('centurion', pid);
    if (evs.some((e) => e.points >= 5)) add('heavy-lifter', pid);
    // day-bucketed checks (in household timezone)
    const byDay = {};
    for (const e of evs) {
      const ymd = localYMD(e.doneAt, state.settings.timeZone);
      (byDay[ymd] || (byDay[ymd] = [])).push(e);
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: state.settings.timeZone, hour: 'numeric', hour12: false }).format(new Date(e.doneAt)));
      if (hour < 9) add('early-bird', pid);
    }
    for (const [ymd, dayEvs] of Object.entries(byDay)) {
      if (dayEvs.length >= 5) add('grinder', pid);
      const dow = dowOfYMD(ymd);
      if ((dow === 0 || dow === 6) && dayEvs.length >= 3) add('weekend-warrior', pid);
    }
  }

  // household
  const namedBoth = state.people.p1.name !== 'Drew' || state.people.p2.name !== 'Partner';
  const customChore = Object.values(state.chores).some((c) => !c.seed);
  if (namedBoth && customChore) add('setup-star');
  if (lifetimeXP(state) >= 500) add('century-team');

  // week-based household badges. The streak run here mirrors goalStreak()'s one-grace-week
  // tolerance (a near-miss week >=90% of goal holds the run) so the 🔥 streak chip and the
  // on-a-roll / unstoppable / comeback badges stay consistent with each other.
  const weeks = activeWeekKeys(state, now).slice().reverse(); // oldest -> newest
  let runStreak = 0, balancedRun = 0, prevMiss = false, usedGrace = false;
  for (const wk of weeks) {
    const st = weekStats(state, wk);
    if (st.total === 0) { runStreak = 0; balancedRun = 0; usedGrace = false; prevMiss = false; continue; }
    if (st.total >= st.goal * 1.5) add('goal-crushers');
    const share = st.total ? st.byPerson.p1 / st.total : 0.5;
    const balanced = st.met && share >= 0.4 && share <= 0.6;
    if (balanced) add('balanced-week');
    balancedRun = balanced ? balancedRun + 1 : 0;
    if (balancedRun >= 4) add('perfect-pair');
    if (st.met) {
      runStreak++;
      if (runStreak >= 3) add('on-a-roll');
      if (runStreak >= 8) add('unstoppable');
      if (prevMiss) add('comeback');
      prevMiss = false;
    } else if (!usedGrace && st.total >= st.goal * 0.9) {
      usedGrace = true; // one grace week holds the run without advancing it
    } else {
      runStreak = 0; balancedRun = 0; usedGrace = false; prevMiss = true;
    }
  }
  return earned;
}

export function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
