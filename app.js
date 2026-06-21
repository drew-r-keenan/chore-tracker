// app.js — view + controller. Renders from store state; handles all interaction.
import {
  PLAYER_COLORS, WEIGHT_TIERS, uid, defaultState, migrate,
  localYMD, currentWeekKey, shiftWeekKey, weekRangeLabel,
  weekCompletions, goalForWeek, weekStats, lifetimeXP, levelInfo,
  goalStreak, activeWeekKeys, perChoreTotals, activeLog,
  BADGES, earnedBadges, clampInt,
} from './lib.js';
import { store } from './store.js';
import { sync, mergeStates, encodePair, decodePair } from './sync.js';

const WCOLORS = { 1: '#6BA8C4', 2: '#5AA84B', 3: '#E0B23E', 4: '#E8804A', 5: '#D24B6E' };
const EMOJI_CHOICES = ['🧹','🍽️','🧺','🛁','🗑️','🍳','🛒','🛏️','🧽','🐾','🪴','🚗','💻','📦','🧴','🪟','🧊','🔧','🧯','✨','🍪','☕','📚','🧦'];
const AVATAR_EMOJI = ['🦊','🐼','🐱','🐶','🐰','🐨','🦁','🐯','🐸','🦄','🐧','🦉','🐢','🐙','🦋','🌻'];

let route = 'week';
let viewWeek = null;     // currently displayed week key
let statsRange = 8;
let lastTap = null;

/* ------------------------------ boot ------------------------------ */
function boot() {
  const { firstRun, corrupt } = store.init();
  viewWeek = currentWeekKey(store.state.settings);
  applyTheme();
  applyPlayerColors();
  sealPastWeeks();
  primeCelebrations();

  store.subscribe(() => { applyPlayerColors(); render(); });
  sync.onStatus(() => render());

  wireGlobal();
  render();

  if (corrupt) banner('warn', '⚠️ Saved data was unreadable and reset. (A backup of the raw text is in the console.)', () => {});
  if (corrupt && store._corruptBackup) console.warn('Corrupt chore-tracker data backup:', store._corruptBackup);
  if (!store.storageHealthy) banner('warn', "⚠️ This browser won't save data (private mode?). Changes stay until you close the tab. Turn on cloud sync to keep them.");

  if (store.device.sync && store.device.sync.enabled) sync.resume();
  handlePairLink();

  // roll the week forward if the app is left open / reopened past midnight
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume(); });
  window.addEventListener('focus', onResume);
}

function onResume() {
  const cur = currentWeekKey(store.state.settings);
  if (viewWeek && viewWeek === store._lastCur && cur !== store._lastCur) viewWeek = cur;
  store._lastCur = cur;
  sealPastWeeks();
  render();
}

function sealPastWeeks() {
  const cur = currentWeekKey(store.state.settings);
  store._lastCur = cur;
  const weeks = new Set(activeLog(store.state).map((e) => e.weekKey));
  const need = [];
  for (const wk of weeks) if (wk < cur && !store.state.weekMeta[wk]) need.push(wk);
  if (need.length) store.mutate((s) => { for (const wk of need) s.weekMeta[wk] = { goal: s.settings.weeklyGoal, goalMode: s.settings.goalMode }; });
}

function primeCelebrations() {
  store.device.seenBadges = Array.from(earnedBadges(store.state));
  store._persistDevice();
  store._lastLevel = levelInfo(lifetimeXP(store.state)).level;
}

/* ------------------------------ helpers ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isFutureWeek = (wk) => wk > currentWeekKey(store.state.settings);
const isCurrentWeek = (wk) => wk === currentWeekKey(store.state.settings);
const person = (id) => store.state.people[id];
const sortedChores = () => Object.values(store.state.chores).filter((c) => c.active).sort((a, b) => (a.order || 0) - (b.order || 0));
function fmtTime(ms) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: store.state.settings.timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
  catch { return ''; }
}
function applyPlayerColors() {
  document.documentElement.style.setProperty('--p1', person('p1').color);
  document.documentElement.style.setProperty('--p2', person('p2').color);
}
function applyTheme() {
  const t = store.device.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

/* ------------------------------ render ------------------------------ */
function render() {
  renderHeader();
  renderBanners();
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === route;
    t.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + route; });
  if (route === 'week') renderWeek();
  else if (route === 'stats') renderStats();
  else if (route === 'chores') renderChores();
  else if (route === 'settings') renderSettings();
}

function renderHeader() {
  const xp = lifetimeXP(store.state);
  const lv = levelInfo(xp);
  const streak = goalStreak(store.state);
  const host = $('#topbar-stats');
  host.innerHTML = `
    <button class="chip level-chip" data-action="go-stats" title="${lv.name} · ${xp} lifetime pts">
      <span>Lv ${lv.level}</span>
      <span class="lvl-bar"><span class="lvl-fill" style="width:${lv.pct}%"></span></span>
    </button>
    ${streak.display > 0 ? `<span class="chip" title="${streak.display}-week goal streak">🔥 <span class="big">${streak.display}</span></span>` : ''}
  `;
}

function renderBanners() {
  // sync status (only when enabled), other transient banners handled by banner()
  const host = $('#banners');
  const persistent = Array.from(host.querySelectorAll('[data-keep]'));
  host.innerHTML = '';
  persistent.forEach((p) => host.appendChild(p));
}
let bannerSeq = 0;
function banner(kind, html, onClose) {
  const host = $('#banners');
  const el = document.createElement('div');
  el.className = 'card';
  el.style.cssText = 'margin:0 0 10px;border-color:' + (kind === 'warn' ? '#E0A33E' : 'var(--accent)') + ';display:flex;gap:10px;align-items:center;';
  el.dataset.keep = '1';
  const id = 'bn' + (++bannerSeq);
  el.innerHTML = `<div style="flex:1;font-size:13.5px">${html}</div><button class="icon-btn" data-close="${id}" aria-label="Dismiss" style="width:32px;height:32px;font-size:15px">✕</button>`;
  el.id = id;
  el.querySelector('[data-close]').onclick = () => { el.remove(); if (onClose) onClose(); };
  host.appendChild(el);
  return el;
}

/* ------------------------------ WEEK view ------------------------------ */
function renderWeek() {
  const v = $('#view-week');
  const st = weekStats(store.state, viewWeek);
  const p1 = person('p1'), p2 = person('p2');
  const future = isFutureWeek(viewWeek);
  const leadId = st.byPerson.p1 === st.byPerson.p2 ? null : (st.byPerson.p1 > st.byPerson.p2 ? 'p1' : 'p2');

  const chores = sortedChores();
  const groups = [
    { key: 'p1', title: `${esc(p1.name)}'s`, items: chores.filter((c) => c.assignee === 'p1') },
    { key: 'p2', title: `${esc(p2.name)}'s`, items: chores.filter((c) => c.assignee === 'p2') },
    { key: 'either', title: 'Anyone\'s', items: chores.filter((c) => c.assignee === 'either') },
  ].filter((g) => g.items.length);
  const anyAssigned = chores.some((c) => c.assignee !== 'either');

  const done = weekCompletions(store.state, viewWeek);

  v.innerHTML = `
    <div class="weeknav">
      <button class="nav-btn" data-action="week-prev" aria-label="Previous week">‹</button>
      <div class="wk"><div class="rng">${weekRangeLabel(viewWeek)}</div><div class="sub">${weekLabel(viewWeek)}</div></div>
      <button class="nav-btn" data-action="week-next" aria-label="Next week">›</button>
    </div>
    ${!isCurrentWeek(viewWeek) ? `<button class="today-pill" data-action="week-today">Jump to this week</button>` : ''}

    <div class="card goal-card">
      <div class="card-title">${st.mode === 'perPerson' ? 'Weekly goal · each' : 'Weekly goal · together'}</div>
      <div class="ring-wrap">${ring(st)}
        <div class="ring-center">
          <div class="pts tnum">${st.total}<span class="of">/${st.goal}</span></div>
          <div class="lbl">${st.met ? 'Goal smashed! 🎉' : (st.goal - st.total) + ' pts to go'}</div>
        </div>
      </div>
      ${st.met ? `<span class="goal-met-banner">✓ Goal reached this week</span>` : ''}
    </div>

    <div class="scoreboard">
      ${playerCard('p1', st, leadId)}
      ${playerCard('p2', st, leadId)}
    </div>
    <div class="card split">
      <div class="split-bar" role="img" aria-label="${esc(p1.name)} ${st.byPerson.p1} points, ${esc(p2.name)} ${st.byPerson.p2} points">
        <div class="a" style="width:${st.total ? (st.byPerson.p1 / st.total) * 100 : 50}%"></div>
        <div class="b" style="width:${st.total ? (st.byPerson.p2 / st.total) * 100 : 50}%"></div>
      </div>
      <div class="split-legend"><span>${esc(p1.name)} <b>${st.total ? Math.round((st.byPerson.p1 / st.total) * 100) : 0}%</b></span><span><b>${st.total ? Math.round((st.byPerson.p2 / st.total) * 100) : 0}%</b> ${esc(p2.name)}</span></div>
      ${imbalanceNote(st)}
    </div>

    ${future ? `<div class="empty"><span class="em">🔮</span><div class="et">Future week</div><div>You can pre-plan here, but chores can only be checked off once the week arrives.</div></div>` : ''}

    <div class="list-head"><h2>Chores</h2><button class="btn ghost" data-action="go-chores" style="padding:6px 12px;font-size:13px">＋ Manage</button></div>
    ${chores.length === 0
      ? `<div class="empty"><span class="em">🧺</span><div class="et">No chores yet</div><div>Add your first chore to start scoring.</div><br><button class="btn primary" data-action="add-chore">Add a chore</button></div>`
      : groups.map((g) => `
        ${anyAssigned ? `<div class="list-head" style="margin-top:6px"><h2 style="font-size:12px">${g.title}</h2></div>` : ''}
        ${g.items.map((c) => choreRow(c, future)).join('')}
      `).join('')}

    ${done.length ? `
      <div class="card" style="margin-top:14px">
        <div class="card-title">Done this week · ${done.length}</div>
        ${done.map(doneRow).join('')}
      </div>` : (chores.length && !future ? `<div class="empty" style="padding:14px"><div>Nothing logged yet — tap a chore above to score your first points! 💪</div></div>` : '')}
  `;
}

function ring(st) {
  const r = 82, C = 2 * Math.PI * r, cx = 94, cy = 94;
  const progress = st.goal > 0 ? Math.min(1, st.total / st.goal) : 0;
  const seg1 = st.total ? progress * (st.byPerson.p1 / st.total) : 0;
  const seg12 = progress;
  const dash = (frac) => `${(frac * C).toFixed(2)} ${C.toFixed(2)}`;
  const trackColor = st.met ? 'var(--good)' : 'var(--surface-2)';
  return `<svg aria-hidden="true" viewBox="0 0 188 188" width="188" height="188" style="transform:rotate(-90deg)">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${trackColor}" stroke-width="14"/>
    ${!st.met ? `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--p2)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash(seg12)}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--p1)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash(seg1)}"/>
    ` : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--good)" stroke-width="14"/>`}
  </svg>`;
}

function playerCard(id, st, leadId) {
  const p = person(id);
  const lv = levelInfo(st.byPerson[id]); // (unused detailed) keep simple
  return `<div class="player-card ${leadId === id ? 'lead' : ''}" style="--pcolor:${p.color}">
    ${leadId === id ? '<span class="crown">👑</span>' : ''}
    <button class="avatar" data-action="edit-player" data-id="${id}" aria-label="Edit ${esc(p.name)}">${esc(p.emoji)}</button>
    <div class="pname">${esc(p.name)}</div>
    <div class="pscore tnum">${st.byPerson[id]}</div>
    <div class="pmeta">points this week</div>
  </div>`;
}

function imbalanceNote(st) {
  if (st.total < 6) return '';
  const share1 = st.byPerson.p1 / st.total;
  if (share1 >= 0.7 || share1 <= 0.3) {
    const heavy = share1 > 0.5 ? person('p1') : person('p2');
    const light = share1 > 0.5 ? person('p2') : person('p1');
    if (!st.met && !isFutureWeek(viewWeek)) {
      return `<div class="muted" style="font-size:12.5px;margin-top:8px;text-align:center">${esc(heavy.name)} has carried more this week — ${esc(light.name)}, grabbing one would help hit the goal 🙌</div>`;
    }
    return `<div class="muted" style="font-size:12.5px;margin-top:8px;text-align:center">Thanks ${esc(heavy.name)} for carrying a bit more this week 💛</div>`;
  }
  if (st.met) return `<div class="muted" style="font-size:12.5px;margin-top:8px;text-align:center">Nicely balanced week — great teamwork! ⚖️</div>`;
  return '';
}

function choreRow(c, future) {
  const p1 = person('p1'), p2 = person('p2');
  const wc = WCOLORS[c.weight] || 'var(--muted)';
  const neglect = neglectTag(c);
  const assignedColor = c.assignee === 'p1' ? p1.color : c.assignee === 'p2' ? p2.color : 'transparent';
  const btn = (pid, emph) => {
    const p = person(pid);
    return `<button class="do-btn ${emph ? '' : 'de-emph'}" data-action="do" data-chore="${c.id}" data-person="${pid}" style="--pcolor:${p.color}" aria-label="Mark ${esc(c.name)} done by ${esc(p.name)}" ${future ? 'disabled' : ''}>${esc(p.emoji)}</button>`;
  };
  let actions;
  if (c.assignee === 'p1') actions = btn('p1', true) + btn('p2', false);
  else if (c.assignee === 'p2') actions = btn('p2', true) + btn('p1', false);
  else actions = btn('p1', true) + btn('p2', true);
  return `<div class="chore-row ${c.assignee !== 'either' ? 'assigned' : ''}" style="--pcolor:${assignedColor}">
    <span class="w-chip" style="--wcolor:${wc}">${c.weight}</span>
    <div class="c-main">
      <div class="c-name">${esc(c.icon || '')} ${esc(c.name)}</div>
      <div class="c-sub">${c.assignee === 'either' ? 'Anyone' : esc(person(c.assignee).name)} · ${c.weight} pt${c.weight > 1 ? 's' : ''}${neglect}</div>
    </div>
    <div class="c-actions">${actions}</div>
  </div>`;
}

function neglectTag(c) {
  const evs = activeLog(store.state).filter((e) => e.choreId === c.id);
  if (!evs.length) return '';
  const last = Math.max(...evs.map((e) => e.doneAt));
  const days = Math.floor((Date.now() - last) / 86400000);
  if (days >= 10) return ` · <span style="color:var(--accent)">⏰ ${days}d ago</span>`;
  return '';
}

function doneRow(e) {
  const p = person(e.personId);
  return `<div class="done-row" style="--pcolor:${p.color}">
    <span class="dot">${esc(p.emoji)}</span>
    <span class="d-name">${esc(e.icon || '')} ${esc(e.choreName)} <span class="muted" style="font-size:11px">· ${fmtTime(e.doneAt)}</span></span>
    <span class="d-pts">+${e.points}</span>
    <button class="undo-x" data-action="undo" data-id="${e.id}" aria-label="Undo ${esc(e.choreName)}">↩︎</button>
  </div>`;
}

function weekLabel(wk) {
  if (isCurrentWeek(wk)) return 'This week';
  const cur = currentWeekKey(store.state.settings);
  if (wk === shiftWeekKey(cur, -1)) return 'Last week';
  if (wk === shiftWeekKey(cur, 1)) return 'Next week';
  return isFutureWeek(wk) ? 'Upcoming' : 'Past week';
}

/* ------------------------------ completion flow ------------------------------ */
function completeChore(choreId, personId, btnEl) {
  if (isFutureWeek(viewWeek)) return;
  const c = store.state.chores[choreId];
  if (!c) return;
  const now = Date.now();
  if (lastTap && lastTap.k === choreId + personId && now - lastTap.t < 700) return; // double-tap guard
  lastTap = { k: choreId + personId, t: now };

  const rect = btnEl ? btnEl.getBoundingClientRect() : null;
  // backfill: keep weekKey authoritative; give past entries a representative timestamp for day-badges/display
  const doneAt = isCurrentWeek(viewWeek) ? now : repTimestamp(viewWeek);
  const id = uid('e_');
  store.mutate((s) => {
    s.log[id] = { id, choreId, choreName: c.name, icon: c.icon, personId, points: c.weight, doneAt, weekKey: viewWeek };
  });
  if (rect) flyPoints(rect, '+' + c.weight, person(personId).color);
  haptic(30); sound('pop');
  checkCelebrations(viewWeek);
  showUndo(id, `${c.name} · +${c.weight} for ${person(personId).name}`);
}

function repTimestamp(weekKey) {
  const [y, m, d] = weekKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 18, 0, 0) + 3 * 86400000; // ~midweek noon-ish
}

function undoCompletion(id) {
  const e = store.state.log[id];
  if (!e) return;
  const wk = e.weekKey;
  store.mutate((s) => { if (s.log[id]) { s.log[id] = { ...s.log[id], deleted: true, deletedAt: Date.now() }; } });
  haptic(15);
  checkCelebrations(wk);
}

function checkCelebrations(weekKey) {
  const st = weekStats(store.state, weekKey);
  if (st.met && !store.hasCelebratedWeek(weekKey)) { store.markWeekCelebrated(weekKey); celebrateGoal(st); }
  if (!st.met && store.hasCelebratedWeek(weekKey)) store.unmarkWeekCelebrated(weekKey);

  const earned = earnedBadges(store.state);
  const fresh = store.newlySeenBadges(earned);
  for (const token of fresh) toastBadge(token);

  const lv = levelInfo(lifetimeXP(store.state)).level;
  if (store._lastLevel != null && lv > store._lastLevel) toastLevel(lv);
  store._lastLevel = lv;
}

/* ------------------------------ STATS view ------------------------------ */
function renderStats() {
  const v = $('#view-stats');
  const allWeeks = activeWeekKeys(store.state); // newest first
  const n = statsRange === 'all' ? allWeeks.length : Math.min(statsRange, allWeeks.length);
  const weeks = allWeeks.slice(0, Math.max(n, 1)).reverse(); // oldest -> newest for chart
  const stats = weeks.map((wk) => weekStats(store.state, wk));
  const rangeKeys = weeks;

  const totals = stats.reduce((a, s) => { a.p1 += s.byPerson.p1; a.p2 += s.byPerson.p2; return a; }, { p1: 0, p2: 0 });
  const grand = totals.p1 + totals.p2;
  const best = stats.reduce((m, s) => Math.max(m, s.total), 0);
  const metCount = stats.filter((s) => s.total > 0 && s.met).length;
  const activeCount = stats.filter((s) => s.total > 0).length;
  const streak = goalStreak(store.state);
  const choreRows = perChoreTotals(store.state, rangeKeys);
  const p1 = person('p1'), p2 = person('p2');

  const hasData = grand > 0;
  v.innerHTML = `
    <div class="range-chips">
      ${[4, 8, 12, 'all'].map((r) => `<button class="${statsRange === r ? 'on' : ''}" data-action="range" data-r="${r}">${r === 'all' ? 'All' : r + 'w'}</button>`).join('')}
    </div>

    ${!hasData ? `<div class="empty"><span class="em">📊</span><div class="et">No data yet</div><div>Complete some chores and your week-over-week trends show up here.</div></div>` : `
    <div class="card">
      <div class="card-title">Points by week — who did what</div>
      <div class="chart-wrap">${barChart(stats)}</div>
      <div class="split-legend" style="margin-top:8px"><span style="color:${p1.color}">● ${esc(p1.name)}</span><span style="color:var(--muted)">- - goal</span><span style="color:${p2.color}">● ${esc(p2.name)}</span></div>
    </div>

    <div class="card">
      <div class="card-title">Split of labor</div>
      <div class="donut-row">
        ${donut(totals.p1, totals.p2)}
        <div style="flex:1">
          <div class="kv"><span style="color:${p1.color}">● ${esc(p1.name)}</span><b>${grand ? Math.round(totals.p1 / grand * 100) : 0}% · ${totals.p1} pts</b></div>
          <div class="kv"><span style="color:${p2.color}">● ${esc(p2.name)}</span><b>${grand ? Math.round(totals.p2 / grand * 100) : 0}% · ${totals.p2} pts</b></div>
          <div class="kv" style="border:none"><span>Total</span><b>${grand} pts</b></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Highlights</div>
      <div class="kv"><span>🔥 Current goal streak</span><b>${streak.display} week${streak.display === 1 ? '' : 's'}</b></div>
      <div class="kv"><span>🎯 Weeks goal met</span><b>${metCount} / ${activeCount}</b></div>
      <div class="kv"><span>🏆 Best week</span><b>${best} pts</b></div>
      <div class="kv" style="border:none"><span>⭐ Lifetime points</span><b>${lifetimeXP(store.state)}</b></div>
    </div>

    <div class="card">
      <div class="card-title">By chore</div>
      <table class="stat-table">
        <thead><tr><th>Chore</th><th>${esc(p1.name)}</th><th>${esc(p2.name)}</th><th>Total</th></tr></thead>
        <tbody>${choreRows.map((r) => `<tr><td>${esc(r.icon)} ${esc(r.name)}</td><td class="tnum">${r.p1}</td><td class="tnum">${r.p2}</td><td class="tnum"><b>${r.total}</b></td></tr>`).join('')}</tbody>
      </table>
    </div>`}

    <div class="card">
      <div class="card-title">Achievements</div>
      ${badgeGrid()}
    </div>
  `;
}

function barChart(stats) {
  const W = Math.max(stats.length * 46 + 30, 300), H = 180, pad = 24, base = H - 22, top = 14;
  const goal = stats.length ? stats[stats.length - 1].goal : store.state.settings.weeklyGoal;
  const maxVal = Math.max(goal, ...stats.map((s) => s.total), 1);
  const scale = (v) => (v / maxVal) * (base - top);
  const colW = 28, gap = (W - 30 - stats.length * colW) / (stats.length + 1);
  const goalY = base - scale(goal);
  let bars = '';
  stats.forEach((s, i) => {
    const x = 15 + gap + i * (colW + gap);
    const h1 = scale(s.byPerson.p1), h2 = scale(s.byPerson.p2);
    const y1 = base - h1, y2 = y1 - h2;
    bars += `
      ${h1 > 0 ? `<rect x="${x}" y="${y1.toFixed(1)}" width="${colW}" height="${h1.toFixed(1)}" rx="3" fill="${person('p1').color}"/>` : ''}
      ${h2 > 0 ? `<rect x="${x}" y="${y2.toFixed(1)}" width="${colW}" height="${h2.toFixed(1)}" rx="3" fill="${person('p2').color}"/>` : ''}
      <text x="${x + colW / 2}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">${shortWk(s.weekKey)}</text>
      ${s.total > 0 ? `<text x="${x + colW / 2}" y="${(Math.min(y2, y1) - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--text)">${s.total}</text>` : ''}`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:none">
    <line x1="10" y1="${base}" x2="${W - 6}" y2="${base}" stroke="var(--line)"/>
    <line x1="10" y1="${goalY.toFixed(1)}" x2="${W - 6}" y2="${goalY.toFixed(1)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <text x="${W - 6}" y="${(goalY - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--accent)">goal ${goal}</text>
    ${bars}
  </svg>`;
}
function shortWk(wk) { const [, m, d] = wk.split('-'); return `${Number(m)}/${Number(d)}`; }

function donut(a, b) {
  const total = a + b, r = 34, C = 2 * Math.PI * r;
  const fa = total ? a / total : 0.5;
  return `<svg viewBox="0 0 90 90" width="90" height="90" style="transform:rotate(-90deg);flex:0 0 auto">
    <circle cx="45" cy="45" r="${r}" fill="none" stroke="${person('p2').color}" stroke-width="16"/>
    <circle cx="45" cy="45" r="${r}" fill="none" stroke="${person('p1').color}" stroke-width="16" stroke-dasharray="${(fa * C).toFixed(1)} ${C.toFixed(1)}"/>
  </svg>`;
}

function badgeGrid() {
  const earned = earnedBadges(store.state);
  return `<div class="badge-grid">${BADGES.map((b) => {
    let who = '', got = false;
    if (b.scope === 'household') { got = earned.has(b.id); }
    else {
      const e1 = earned.has(b.id + ':p1'), e2 = earned.has(b.id + ':p2');
      got = e1 || e2;
      who = (e1 ? person('p1').emoji : '') + (e2 ? person('p2').emoji : '');
    }
    return `<div class="badge ${got ? '' : 'locked'}" title="${esc(b.desc)}">
      <div class="be">${b.emoji}</div><div class="bn">${esc(b.name)}</div><div class="bd">${esc(b.desc)}</div>
      ${who ? `<div class="bwho">${who}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

/* ------------------------------ CHORES view ------------------------------ */
function renderChores() {
  const v = $('#view-chores');
  const chores = sortedChores();
  v.innerHTML = `
    <div class="list-head"><h2>Your chores</h2><span class="muted" style="font-size:12px">${chores.length} active</span></div>
    ${chores.length ? chores.map((c) => {
      const wc = WCOLORS[c.weight];
      return `<div class="chore-def">
        <span class="w-chip" style="--wcolor:${wc}">${c.weight}</span>
        <div class="cd-main"><div class="cd-name">${esc(c.icon || '')} ${esc(c.name)}</div>
        <div class="cd-sub">${c.weight} pt${c.weight > 1 ? 's' : ''} · ${c.assignee === 'either' ? 'Anyone' : esc(person(c.assignee).name)}</div></div>
        <button class="edit-btn" data-action="edit-chore" data-id="${c.id}" aria-label="Edit ${esc(c.name)}">✏️</button>
      </div>`;
    }).join('') : `<div class="empty"><span class="em">📋</span><div class="et">No chores</div><div>Add chores so you can start scoring.</div></div>`}
    <div style="height:70px"></div>
    <div class="fab"><button class="btn primary" data-action="add-chore">＋ Add chore</button></div>
  `;
}

/* ------------------------------ SETTINGS view ------------------------------ */
function renderSettings() {
  const v = $('#view-settings');
  const s = store.state.settings;
  const d = store.device;
  const sc = d.sync || {};
  const statusCls = sync.status === 'connected' ? 'connected' : sync.status === 'connecting' ? 'connecting' : sync.status === 'error' ? 'error' : '';
  const statusTxt = sync.status === 'connected' ? `Synced · ${esc(sc.code || '')}` : sync.status === 'connecting' ? 'Connecting…' : sync.status === 'error' ? 'Sync error' : 'Local only';

  v.innerHTML = `
    <div class="card">
      <div class="card-title">Players</div>
      ${['p1', 'p2'].map((id) => { const p = person(id); return `
        <div class="set-row">
          <button class="avatar" data-action="edit-player" data-id="${id}" style="--pcolor:${p.color};width:44px;height:44px;font-size:22px;border-radius:999px;display:grid;place-items:center;border:3px solid ${p.color};background:color-mix(in srgb, ${p.color} 14%, var(--surface))">${esc(p.emoji)}</button>
          <div class="sr-main"><div class="sr-name">${esc(p.name)}</div><div class="sr-sub">Tap avatar to rename / restyle</div></div>
          <span style="width:18px;height:18px;border-radius:999px;background:${p.color}"></span>
        </div>`; }).join('')}
    </div>

    <div class="card">
      <div class="card-title">Weekly goal</div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Target points</div><div class="sr-sub">A full week of your chores ≈ ${fullWeekEstimate()} pts</div></div>
        <div class="stepper">
          <button data-action="goal" data-d="-5" aria-label="Lower goal">−</button>
          <span class="val tnum">${s.weeklyGoal}</span>
          <button data-action="goal" data-d="5" aria-label="Raise goal">＋</button>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Goal mode</div><div class="sr-sub">${s.goalMode === 'combined' ? 'Combined household total' : 'Each person hits half'}</div></div>
        <div class="seg" style="width:170px">
          <button class="${s.goalMode === 'combined' ? 'on' : ''}" data-action="goalmode" data-m="combined">Together</button>
          <button class="${s.goalMode === 'perPerson' ? 'on' : ''}" data-action="goalmode" data-m="perPerson">Each</button>
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Week starts on</div></div>
        <div class="seg" style="width:170px">
          <button class="${s.weekStartsOn === 1 ? 'on' : ''}" data-action="weekstart" data-w="1">Monday</button>
          <button class="${s.weekStartsOn === 0 ? 'on' : ''}" data-action="weekstart" data-w="0">Sunday</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Appearance & feedback</div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Theme</div></div>
        <div class="seg" style="width:210px">
          ${['system', 'light', 'dark'].map((t) => `<button class="${d.theme === t ? 'on' : ''}" data-action="theme" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Sound effects</div><div class="sr-sub">A little pop when you score</div></div>
        <button class="switch ${d.sound ? 'on' : ''}" data-action="sound" role="switch" aria-checked="${d.sound}"><span class="knob"></span></button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Cloud sync <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></div>
      <p class="muted" style="font-size:13px;margin:0 0 12px">Your data already works on this device. Sync only matters if you want it shared between two phones.</p>
      <div class="set-row">
        <div class="sr-main"><div class="sr-name">Status</div>${sync.error ? `<div class="sr-sub" style="color:#C0392B">${esc(sync.error)}</div>` : ''}</div>
        <span class="sync-status ${statusCls}"><span class="led"></span>${statusTxt}</span>
      </div>
      ${sync.status === 'connected' ? `
        <div class="set-row" style="display:block">
          <div class="sr-name" style="margin-bottom:6px">Pair your other device</div>
          <div class="code-box" id="pair-link">${esc(pairLink())}</div>
          <div class="btn-row" style="margin-top:8px"><button class="btn" data-action="copy-pair">Copy invite link</button></div>
          <div class="sr-sub" style="margin-top:6px">Open that link on the second phone — or paste the same config + code below.</div>
        </div>
        <div class="btn-row" style="margin-top:8px"><button class="btn danger full" data-action="sync-disable">Disconnect sync</button></div>
      ` : `<div class="btn-row"><button class="btn primary full" data-action="sync-setup">Set up cloud sync</button></div>`}
    </div>

    <div class="card">
      <div class="card-title">Your data</div>
      <div class="btn-row"><button class="btn" data-action="export">Export backup</button><button class="btn" data-action="import">Import backup</button></div>
      <div class="btn-row" style="margin-top:10px"><button class="btn danger full" data-action="reset">Reset everything</button></div>
    </div>
    <p class="center muted" style="font-size:12px;margin-top:4px">Chore Quest · made for you two 💛</p>
  `;
}

function fullWeekEstimate() { return Object.values(store.state.chores).filter((c) => c.active).reduce((s, c) => s + c.weight, 0); }
function pairLink() {
  const sc = store.device.sync || {};
  if (!sc.config || !sc.code) return '';
  return `${location.origin}${location.pathname}#pair=${encodePair(sc.config, sc.code)}`;
}

/* ------------------------------ sheets ------------------------------ */
let _sheetReturnFocus = null;
function openSheet(html, onMount) {
  const sheet = $('#sheet');
  _sheetReturnFocus = document.activeElement;
  sheet.innerHTML = `<div class="sheet-grab"></div>` + html;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  const app = document.getElementById('app');
  if ('inert' in HTMLElement.prototype) app.inert = true;       // background not focusable/tabbable
  // keep Tab focus inside the dialog
  sheet.onkeydown = (e) => {
    if (e.key !== 'Tab') return;
    const f = sheet.querySelectorAll('input,textarea,button,select,a[href],[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  if (onMount) onMount(sheet);
  const first = sheet.querySelector('input,textarea,button');
  if (first) setTimeout(() => first.focus(), 50);
}
function closeSheet() {
  if ($('#sheet-backdrop').hidden) return;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  const app = document.getElementById('app');
  if ('inert' in HTMLElement.prototype) app.inert = false;
  if (_sheetReturnFocus && typeof _sheetReturnFocus.focus === 'function') { try { _sheetReturnFocus.focus(); } catch {} }
  _sheetReturnFocus = null;
}

function choreSheet(choreId) {
  const editing = !!choreId;
  const c = editing ? store.state.chores[choreId] : { name: '', weight: 2, assignee: 'either', icon: '🧹' };
  let sel = { name: c.name, weight: c.weight, assignee: c.assignee, icon: c.icon || '🧹' };
  openSheet(`
    <h2>${editing ? 'Edit chore' : 'Add chore'}</h2>
    <div class="field"><label>Name</label><input type="text" id="c-name" value="${esc(sel.name)}" placeholder="e.g. Mop the floors" maxlength="40"></div>
    <div class="field"><label>Effort / points</label>
      <div class="seg weights" id="c-weight">${WEIGHT_TIERS.map((t) => `<button data-w="${t.value}" class="${sel.weight === t.value ? 'on' : ''}">${t.value}<span class="wl">${t.label}</span></button>`).join('')}</div>
    </div>
    <div class="field"><label>Assign to</label>
      <div class="seg" id="c-assignee">
        <button data-a="p1" class="${sel.assignee === 'p1' ? 'on' : ''}">${esc(person('p1').emoji)} ${esc(person('p1').name)}</button>
        <button data-a="p2" class="${sel.assignee === 'p2' ? 'on' : ''}">${esc(person('p2').emoji)} ${esc(person('p2').name)}</button>
        <button data-a="either" class="${sel.assignee === 'either' ? 'on' : ''}">Anyone</button>
      </div>
    </div>
    <div class="field"><label>Icon</label><div class="emoji-grid" id="c-icon">${EMOJI_CHOICES.map((e) => `<button data-e="${e}" class="${sel.icon === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
    <div class="btn-row"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn primary" id="c-save">${editing ? 'Save' : 'Add chore'}</button></div>
    ${editing ? `<button class="btn danger full ghost" id="c-archive" style="margin-top:10px">Remove chore (keeps history)</button>` : ''}
  `, (sheet) => {
    segPick(sheet, '#c-weight', 'w', (v) => { sel.weight = Number(v); });
    segPick(sheet, '#c-assignee', 'a', (v) => { sel.assignee = v; });
    gridPick(sheet, '#c-icon', 'e', (v) => { sel.icon = v; });
    sheet.querySelector('#c-save').onclick = () => {
      const name = sheet.querySelector('#c-name').value.trim();
      if (!name) { sheet.querySelector('#c-name').focus(); return; }
      const weight = clampInt(sel.weight, 1, 5, 2);
      store.mutate((st) => {
        if (editing) { Object.assign(st.chores[choreId], { name, weight, assignee: sel.assignee, icon: sel.icon }); }
        else { const id = uid('c_'); const order = Object.keys(st.chores).length; st.chores[id] = { id, name, weight, assignee: sel.assignee, icon: sel.icon, active: true, seed: false, order, createdAt: Date.now() }; }
      });
      closeSheet();
    };
    if (editing) sheet.querySelector('#c-archive').onclick = () => {
      if (!confirm('Remove this chore from your lists? Past completions and points are kept.')) return;
      store.mutate((st) => { st.chores[choreId].active = false; st.chores[choreId].archivedAt = Date.now(); });
      closeSheet();
    };
  });
}

function playerSheet(id) {
  const p = person(id);
  let sel = { emoji: p.emoji, color: p.color };
  openSheet(`
    <h2>Edit player</h2>
    <div class="field"><label>Name</label><input type="text" id="p-name" value="${esc(p.name)}" maxlength="24"></div>
    <div class="field"><label>Avatar</label><div class="emoji-grid" id="p-emoji">${AVATAR_EMOJI.map((e) => `<button data-e="${e}" class="${sel.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
    <div class="field"><label>Color</label><div class="color-grid" id="p-color">${PLAYER_COLORS.map((col) => `<button data-c="${col}" class="${sel.color === col ? 'on' : ''}" style="background:${col}" aria-label="color"></button>`).join('')}</div></div>
    <div class="btn-row"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn primary" id="p-save">Save</button></div>
  `, (sheet) => {
    gridPick(sheet, '#p-emoji', 'e', (v) => { sel.emoji = v; });
    sheet.querySelectorAll('#p-color button').forEach((b) => b.onclick = () => { sel.color = b.dataset.c; sheet.querySelectorAll('#p-color button').forEach((x) => x.classList.toggle('on', x === b)); });
    sheet.querySelector('#p-save').onclick = () => {
      const name = sheet.querySelector('#p-name').value.trim() || p.name;
      store.mutate((st) => { Object.assign(st.people[id], { name, emoji: sel.emoji, color: sel.color }); });
      checkCelebrations(viewWeek); // setup-star badge
      closeSheet();
    };
  });
}

function segPick(root, sel, attr, cb) {
  root.querySelectorAll(sel + ' button').forEach((b) => b.onclick = () => {
    root.querySelectorAll(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
    cb(b.dataset[attr]);
  });
}
function gridPick(root, sel, attr, cb) { segPick(root, sel, attr, cb); }

function syncSheet(prefill) {
  const sc = store.device.sync || {};
  const cfg = prefill?.config || sc.config;
  const code = prefill?.code || sc.code || genCode();
  openSheet(`
    <h2>Set up cloud sync</h2>
    <p class="muted" style="font-size:13px;margin-top:-6px">Paste your Firebase web config and pick a shared household code. Both phones use the same two things. <a href="#" data-action="sync-help">How do I get this?</a></p>
    <div class="field"><label>Firebase config</label><textarea id="s-config" placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "...", ... }'>${cfg ? esc(JSON.stringify(cfg, null, 2)) : ''}</textarea></div>
    <div class="field"><label>Household code (share with your spouse)</label><input type="text" id="s-code" value="${esc(code)}"></div>
    <div id="s-msg" class="muted" style="font-size:12.5px;min-height:18px"></div>
    <div class="btn-row"><button class="btn ghost" data-action="close-sheet">Cancel</button><button class="btn primary" id="s-connect">Connect</button></div>
  `, (sheet) => {
    sheet.querySelector('[data-action="sync-help"]').onclick = (e) => { e.preventDefault(); helpSheet(); };
    sheet.querySelector('#s-connect').onclick = async () => {
      const msg = sheet.querySelector('#s-msg');
      const config = parseConfig(sheet.querySelector('#s-config').value);
      const code = sheet.querySelector('#s-code').value.trim().toLowerCase();
      if (!config) { msg.textContent = '⚠️ Could not read that config — paste the whole { ... } object from Firebase.'; return; }
      if (!code || code.length < 4) { msg.textContent = '⚠️ Pick a household code of at least 4 characters.'; return; }
      msg.textContent = 'Connecting…';
      let probe;
      try { probe = await sync.probe(config, code); }
      catch (e) { msg.textContent = '⚠️ ' + (e.message || e); return; }
      const localHasData = activeLog(store.state).length > 0 || Object.values(store.state.chores).some((c) => !c.seed) || person('p1').name !== 'Drew';
      if (probe.exists && localHasData) {
        // both sides have data: let the user choose
        msg.innerHTML = `That household already has data. What should I do?`;
        const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '8px';
        row.innerHTML = `<button class="btn" data-c="cloud">Use cloud data</button><button class="btn" data-c="merge">Merge both</button><button class="btn" data-c="local">Use this device</button>`;
        sheet.querySelector('#s-connect').replaceWith(row);
        row.querySelectorAll('button').forEach((b) => b.onclick = () => finishConnect(config, code, b.dataset.c, probe.remote));
      } else {
        finishConnect(config, code, probe.exists ? 'cloud' : 'local', probe.remote);
      }
    };
  });
}

async function finishConnect(config, code, choice, remote) {
  const res = await sync.connect(config, code, choice, remote);
  closeSheet();
  if (res.ok) { sealPastWeeks(); primeCelebrations(); render(); toast('✅', 'Cloud sync on', 'Both devices using code ' + code); }
  else { render(); banner('warn', '⚠️ ' + res.error); }
}

function parseConfig(text) {
  if (!text) return null;
  let t = text.trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch {}
  try { const obj = (new Function('return (' + t + ')'))(); return (obj && obj.apiKey) ? obj : null; } catch { return null; }
}
function genCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(buf) : buf).forEach((n) => s += a[n % a.length]);
  return 'home-' + s.slice(0, 10);
}

function helpSheet() {
  openSheet(`
    <h2>Get your Firebase config</h2>
    <ol style="font-size:13.5px;line-height:1.7;padding-left:20px">
      <li>Go to <b>console.firebase.google.com</b> → <b>Add project</b> (you can skip Analytics).</li>
      <li><b>Build → Firestore Database → Create database</b> → Production mode → pick a region.</li>
      <li><b>Build → Authentication → Get started →</b> enable <b>Anonymous</b>.</li>
      <li>Gear icon → <b>Project settings → Your apps → Web (&lt;/&gt;)</b> → register an app → copy the <b>firebaseConfig</b> object.</li>
      <li>In Firestore → <b>Rules</b>, paste the rules from the project README, then <b>Publish</b>.</li>
      <li>Paste the config + a household code here on both phones.</li>
    </ol>
    <p class="muted" style="font-size:12.5px">The apiKey in the config is a public identifier, not a secret — safety comes from the rules + anonymous auth + your unguessable code.</p>
    <div class="btn-row"><button class="btn primary full" data-action="close-sheet">Got it</button></div>
  `);
}

/* ------------------------------ data export/import/reset ------------------------------ */
function exportData() {
  const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `chore-quest-backup-${localYMD(Date.now(), store.state.settings.timeZone)}.json`;
  a.click(); URL.revokeObjectURL(url);
}
function importData() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch { alert('That file is not valid JSON.'); return; }
      if (!data || typeof data !== 'object' || !data.people || !data.chores) { alert('That does not look like a Chore Quest backup.'); return; }
      const mode = confirm('Import: OK = Replace everything with this file.\nCancel = Merge into your current data.') ? 'replace' : 'merge';
      const next = mode === 'replace' ? migrate(data) : mergeStates(store.state, migrate(data));
      store.mutate((s) => { Object.assign(s, next); });
      sealPastWeeks(); primeCelebrations(); render();
      toast('✅', 'Backup imported', '');
    };
    reader.readAsText(file);
  };
  input.click();
}
function resetAll() {
  if (!confirm('Reset everything? This erases all chores, points, and history on this device.')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
  store.mutate((s) => { Object.assign(s, defaultState()); });
  viewWeek = currentWeekKey(store.state.settings);
  primeCelebrations(); render();
}

/* ------------------------------ pairing link ------------------------------ */
function handlePairLink() {
  const m = location.hash.match(/pair=([^&]+)/);
  if (!m) return;
  const data = decodePair(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  if (!data || !data.config || !data.code) return;
  if (store.device.sync && store.device.sync.enabled && store.device.sync.code === data.code) return;
  banner('info', `📲 Invite to join household <b>${esc(data.code)}</b>. <button class="btn primary" data-action="accept-pair" style="padding:6px 12px;margin-left:6px">Connect</button>`);
  store._pendingPair = data;
}

/* ------------------------------ feedback fx ------------------------------ */
function flyPoints(rect, text, color) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'fly-pts'; el.textContent = text; el.style.color = color;
  el.style.left = rect.left + rect.width / 2 - 10 + 'px';
  el.style.top = rect.top - 6 + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}
function toast(emoji, title, sub) {
  const region = $('#toast-region');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="te">${emoji}</span><span><span class="tt">${esc(title)}</span>${sub ? `<br><span class="ts">${esc(sub)}</span>` : ''}</span>`;
  region.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2600);
}
function toastBadge(token) {
  const [id, pid] = token.split(':');
  const b = BADGES.find((x) => x.id === id); if (!b) return;
  const who = pid ? ' · ' + person(pid).name : '';
  toast(b.emoji, 'Badge unlocked: ' + b.name, b.desc + who);
  sound('badge');
}
function toastLevel(lv) { toast('⬆️', 'Level up! Lv ' + lv, levelInfo(lifetimeXP(store.state)).name); sound('level'); confettiBurst(0.5); }

let undoTimer = null;
function showUndo(id, label) {
  const sb = $('#snackbar');
  sb.hidden = false;
  sb.innerHTML = `<span>${esc(label)}</span><button data-action="undo-snack" data-id="${id}">Undo</button>`;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { sb.hidden = true; }, 5000);
}

function celebrateGoal(st) {
  toast('🎉', 'Goal smashed!', `${st.total} / ${st.goal} points this week`);
  confettiBurst(1);
  sound('goal'); haptic([20, 40, 20]);
}

/* sound via WebAudio (no assets); haptics via vibrate */
let actx = null;
function sound(kind) {
  if (!store.device.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const map = { pop: [660, .07], badge: [880, .14], level: [990, .2], goal: [740, .25] };
    const [freq, dur] = map[kind] || [660, .07];
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.value = .0001; o.connect(g); g.connect(actx.destination);
    const t = actx.currentTime;
    g.gain.exponentialRampToValueAtTime(.18, t + .01);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.start(t); o.stop(t + dur + .02);
  } catch {}
}
function haptic(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch {} }

/* confetti — tiny hand-rolled canvas */
function confettiBurst(scale = 1) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
  ctx.scale(dpr, dpr);
  const colors = [person('p1').color, person('p2').color, '#E8954A', '#5AA84B', '#F0C040', '#7C6FE8'];
  const N = Math.floor(150 * scale);
  const parts = [];
  for (let i = 0; i < N; i++) parts.push({
    x: innerWidth / 2 + (Math.random() - .5) * 120, y: innerHeight * 0.34,
    vx: (Math.random() - .5) * 11, vy: Math.random() * -13 - 4,
    g: .3 + Math.random() * .15, s: 5 + Math.random() * 6,
    rot: Math.random() * 6, vr: (Math.random() - .5) * .4,
    c: colors[(Math.random() * colors.length) | 0], life: 0,
  });
  let raf;
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;
    for (const p of parts) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= .99;
      if (p.y < innerHeight + 20) alive = true;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / 2600);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6);
      ctx.restore();
    }
    if (alive && t < 2800) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  }
  cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
}

/* ------------------------------ global events ------------------------------ */
function wireGlobal() {
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => { route = t.dataset.tab; if (route === 'week') viewWeek = viewWeek || currentWeekKey(store.state.settings); render(); window.scrollTo(0, 0); });
  $('#theme-btn').onclick = () => { const order = ['system', 'light', 'dark']; const i = order.indexOf(store.device.theme); store.mutateDevice((d) => d.theme = order[(i + 1) % 3]); applyTheme(); };
  $('#sheet-backdrop').onclick = (e) => { if (e.target.id === 'sheet-backdrop') closeSheet(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    const actions = {
      'do': () => completeChore(t.dataset.chore, t.dataset.person, t),
      'undo': () => undoCompletion(t.dataset.id),
      'undo-snack': () => { undoCompletion(t.dataset.id); $('#snackbar').hidden = true; },
      'week-prev': () => { viewWeek = shiftWeekKey(viewWeek, -1); render(); },
      'week-next': () => { viewWeek = shiftWeekKey(viewWeek, 1); render(); },
      'week-today': () => { viewWeek = currentWeekKey(store.state.settings); render(); },
      'go-stats': () => { route = 'stats'; render(); },
      'go-chores': () => { route = 'chores'; render(); },
      'add-chore': () => choreSheet(null),
      'edit-chore': () => choreSheet(t.dataset.id),
      'edit-player': () => playerSheet(t.dataset.id),
      'close-sheet': closeSheet,
      'range': () => { statsRange = t.dataset.r === 'all' ? 'all' : Number(t.dataset.r); render(); },
      'goal': () => store.mutate((s) => s.settings.weeklyGoal = clampInt(s.settings.weeklyGoal + Number(t.dataset.d), 5, 300, 40)),
      'goalmode': () => store.mutate((s) => s.settings.goalMode = t.dataset.m),
      'weekstart': () => { store.mutate((s) => s.settings.weekStartsOn = Number(t.dataset.w)); viewWeek = currentWeekKey(store.state.settings); render(); },
      'theme': () => { store.mutateDevice((d) => d.theme = t.dataset.t); applyTheme(); },
      'sound': () => { store.mutateDevice((d) => d.sound = !d.sound); if (store.device.sound) sound('pop'); },
      'sync-setup': () => syncSheet(),
      'sync-disable': () => { if (confirm('Disconnect cloud sync? Your data stays on this device.')) sync.disable(); },
      'sync-help': () => helpSheet(),
      'accept-pair': () => { syncSheet(store._pendingPair); },
      'copy-pair': () => { navigator.clipboard?.writeText(pairLink()); toast('📋', 'Invite link copied', ''); },
      'export': exportData,
      'import': importData,
      'reset': resetAll,
    };
    if (actions[a]) { e.preventDefault(); actions[a](); }
  });
}

boot();
