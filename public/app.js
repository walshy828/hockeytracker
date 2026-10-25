import { parseRoster } from '/rosterimport.js';
import { gameMarkdown, faceoffSequence, faceoffByPeriod, computeGame, computeShifts, onIceSet, periodLabel, fmt, clockOn, tstamp, RESULTS, STATS, TEAM_STATS } from '/summary.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

const S = {
  players: [], games: [], game: null, events: [],
  impText: '', impRows: [], tab: 'notes', logFilter: 'all', exportText: '',
  composer: { text: '', about: new Set(), stamp: null, voice: false },
  clk: null, perMenu: false, pick: null, foSel: null, foFmt: 'ratio', foZone: 'N', statSel: 0, statPick: false,
  outbox: ls.get('ht_outbox', []), clockDefault: ls.get('ht_clock_default', false), autosave: ls.get('ht_autosave', true),
  nameMode: ls.get('ht_name_mode', 'name'),
};
let rec = null; let flushing = null;

// ---------- clock ----------
const rem = () => { const g = S.game; if (!g) return 0; return g.clock_since ? Math.max(0, g.clock_s - (Date.now() - g.clock_since) / 1000) : g.clock_s; };
const snap = () => ({ period: S.game.period, remaining: rem(), wall_ts: Date.now() });
function setClock(p) {
  Object.assign(S.game, p);
  queue({ key: 'clock', method: 'PATCH', url: `/api/games/${S.game.id}`, body: { period: S.game.period, clock_s: S.game.clock_s, clock_since: S.game.clock_since, status: S.game.status, clock_enabled: S.game.clock_enabled } });
  cache();
}
const toggleClock = () => (S.game.clock_since ? setClock({ clock_s: rem(), clock_since: null }) : setClock({ clock_since: Date.now() }));

// ---------- outbox / sync ----------
function queue(item) {
  if (item.key) { const i = S.outbox.findIndex((o) => o.key === item.key && o !== flushing); if (i >= 0) { S.outbox[i] = item; return save(); } }
  S.outbox.push(item); save(); flush();
}
const save = () => ls.set('ht_outbox', S.outbox);
const cache = () => {
  ls.set('ht_cache', { players: S.players, games: S.games, game: S.game, events: S.events });
  if (S.game) ls.set(`ht_g${S.game.id}`, { game: S.game, events: S.events });
};
// fetch that gives up on a dead/captive rink wifi instead of hanging
const net = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
const isNet = (err) => err instanceof TypeError || err?.name === 'TimeoutError' || err?.name === 'AbortError';
// a game created offline has a temporary negative id; swap in the server's id once it exists
function remapGame(tmp, real) {
  for (const o of S.outbox) { o.url = o.url.replace(`/games/${tmp}`, `/games/${real}`); if (o.body?.game_id === tmp) o.body.game_id = real; }
  for (const e of S.events) if (e.game_id === tmp) e.game_id = real;
  if (S.game?.id === tmp) S.game.id = real;
  const g = S.games.find((x) => x.id === tmp); if (g) g.id = real;
  if (ls.get('ht_game') === tmp) ls.set('ht_game', real);
  try { localStorage.removeItem(`ht_g${tmp}`); } catch {}
  cache();
}
async function flush() {
  if (flushing) return;
  while (S.outbox.length) {
    flushing = S.outbox[0];
    try {
      const r = await net(flushing.url, { method: flushing.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(flushing.body) });
      if (r.status >= 500) throw new Error('server');
      if (flushing.tmp && r.ok) remapGame(flushing.tmp, (await r.json()).id);
    } catch { flushing = null; syncBadge(); return; }
    S.outbox.shift(); flushing = null; save();
  }
  syncBadge();
}
const syncBadge = () => {
  const el = $('#sync'); if (!el) return;
  const off = !navigator.onLine;
  el.textContent = [off && 'Offline · saved on device', S.outbox.length && `⟳ ${S.outbox.length} unsynced`].filter(Boolean).join(' · ');
};
window.addEventListener('online', () => { flush(); syncBadge(); });
window.addEventListener('offline', syncBadge);
setInterval(() => S.outbox.length && flush(), 8000);

// ---------- events ----------
function addEvent(type, player_id, data = {}, stamp = snap()) {
  const e = { cid: rid(), game_id: S.game.id, type, player_id: player_id ?? null, data, ...stamp };
  S.events.push(e);
  queue({ method: 'POST', url: `/api/games/${S.game.id}/events`, body: e });
  cache();
  return e;
}
function removeEvent(cid) {
  S.events = S.events.filter((e) => e.cid !== cid);
  const i = S.outbox.findIndex((o) => o.method === 'POST' && o.body?.cid === cid && o !== flushing);
  if (i >= 0) { S.outbox.splice(i, 1); save(); } else queue({ method: 'DELETE', url: `/api/events/${cid}`, body: {} });
  cache();
}
const undoable = (msg, e) => toast(msg, () => { removeEvent(e.cid); render(); });
function toast(msg, undo) {
  const t = $('#toast'); t.hidden = false;
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`;
  if (undo) $('#undo').onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4500);
}
const pname = (id) => S.players.find((p) => p.id === id)?.name || '?';
const given = (n) => n.trim().split(/\s+/)[0];
const NAME_MODES = [['name', 'Name'], ['both', 'Name #'], ['num', '#']];
const short = (p, mode = S.nameMode) => {
  const f = p.name.trim().split(/\s+/)[0];
  const num = p.number ? `#${p.number}` : '';
  if (mode === 'num') return num || f;
  if (mode === 'both') return num ? `${f} ${num}` : f;
  const dup = S.players.some((o) => o.id !== p.id && given(o.name).toLowerCase() === f.toLowerCase());
  return dup && num ? `${f} ${num}` : f;
};
const first = (id) => { const p = S.players.find((x) => x.id === id); return p ? short(p) : '?'; };
const POS_RANK = { C: 0, W: 1, F: 1, D: 2, G: 3 };
const sortPlayers = (l) => l.slice().sort((a, b) => (POS_RANK[a.position] ?? 4) - (POS_RANK[b.position] ?? 4) || (parseInt(a.number) || 999) - (parseInt(b.number) || 999) || a.name.localeCompare(b.name));
const loadPlayers = async () => { S.players = sortPlayers(await api('GET', '/api/players')); };
const focus = () => S.players.find((p) => p.focus);
const centers = () => S.players.filter((p) => p.position === 'C');
const forwards = () => S.players.filter((p) => p.position === 'F' || p.position === 'W');
const foPlayers = () => { const l = [...centers(), ...forwards()]; return l.length ? l : S.players; };

// ---------- views ----------
function header() {
  const g = S.game;
  const sc = g ? computeGame(g, S.players, S.events, rem()).team : null;
  return `<header class="top glass" style="margin:8px 10px 0;padding:10px 12px"><div class="hrow">
    <div class="title">${g ? `vs ${esc(g.opponent)}` : 'Hockey Tracker'}<small>${g ? esc(g.date) + (g.status === 'final' ? ' · FINAL' : '') : 'Create a game in ⚙︎'}</small></div>
    <button class="btn sm" data-act="namemode" title="Player button labels">${NAME_MODES.find(([k]) => k === S.nameMode)[1]}</button><span class="sync" id="sync"></span>${sc ? `<div class="score">${sc.gf}–${sc.ga}<small class="meta" style="display:block;text-align:right">SOG ${sc.sf}–${sc.sa}</small></div>` : ''}</div></header>`;
}
function clockBar() {
  if (!S.game) return '';
  const g = S.game;
  const per = `<div class="perwrap"><div class="per" data-act="permenu">${periodLabel(g.period)} ${S.perMenu ? '▾' : '▸'}</div>${S.perMenu ? `<div class="permenu glass">${[1, 2, 3, 4].map((p) => `<button class="${p === g.period ? 'on' : ''}" data-act="period" data-id="${p}">${periodLabel(p)}</button>`).join('')}</div>` : ''}</div>`;
  if (!clockOn(g)) return `<div class="clock glass" style="margin-top:8px">${per}<div class="sp"></div><button class="btn sm" data-act="clockpower">⏱ Clock off</button></div>`;
  return `<div class="clock glass" style="margin-top:8px">
    <div class="perwrap"><div class="per" data-act="permenu">${periodLabel(g.period)} ${S.perMenu ? '▾' : '▸'}</div>${S.perMenu ? `<div class="permenu glass">${[1, 2, 3, 4].map((p) => `<button class="${p === g.period ? 'on' : ''}" data-act="period" data-id="${p}">${periodLabel(p)}</button>`).join('')}</div>` : ''}</div>
    <div class="t" id="clk" data-act="editclock">${fmt(rem())}</div><div class="sp"></div>
    <button class="btn pri" id="runbtn" data-act="clock" style="min-width:92px;min-height:46px">${g.clock_since ? '⏸ Stop' : '▶ Start'}</button><button class="btn sm" data-act="clockpower" title="Turn clock off">⏱ On</button></div>`;
}
const TABS = [['notes', '🎙', 'Notes'], ['ice', '🧊', 'Ice'], ['faceoff', '⚪️', 'Faceoff'], ['stats', '＋', 'Stats'], ['log', '☰', 'Log'], ['more', '⚙︎', 'More']];
const nav = () => `<nav class="tabs glass">${TABS.map(([k, i, l]) => `<button data-act="tab" data-id="${k}" class="${S.tab === k ? 'on' : ''}"><span>${i}</span>${l}</button>`).join('')}</nav>`;

function aboutChips() {
  return `<div class="chips" id="about">${S.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<div class="chip ${p.focus ? 'focus' : ''} ${S.composer.about.has(p.id) ? 'on' : ''}" data-act="about" data-id="${p.id}">${esc(short(p))}</div>`).join('')}</div>`;
}
function notesView() {
  const notes = S.events.filter((e) => e.type === 'note').slice().reverse().slice(0, 12);
  return `<div class="card glass"><textarea id="nt" placeholder="What just happened? Dictate or type…" autocapitalize="sentences">${esc(S.composer.text)}</textarea>
    <div class="row" style="margin:12px 0"><button class="mic ${rec ? 'rec' : ''}" id="mic" data-act="mic">🎙</button>
      <button class="btn pri big" data-act="savenote" style="flex:1;min-height:76px">Save note</button></div>
    <h3>About (optional)</h3>${aboutChips()}
    <label class="hint row" style="margin-top:12px"><input type="checkbox" id="auto" ${S.autosave ? 'checked' : ''} style="width:auto"> Auto-save when mic stops</label></div>
    <div class="card glass"><h3>Recent notes</h3>${notes.map(noteRow).join('') || '<div class="hint">Nothing yet.</div>'}</div>`;
}
const noteRow = (e) => `<div class="note"><span class="pill">${tstamp(S.game, e)}</span>${(e.data.about || []).map((i) => `<span class="pill">${esc(first(i))}</span>`).join('')}${e.data.source === 'voice' ? '🎙 ' : ''}${esc(e.data.text)}</div>`;

const EMPTY_LINES = { F: [[null, null, null], [null, null, null], [null, null, null], [null, null, null]], D: [[null, null], [null, null], [null, null]] };
const SLOTS = { F: ['LW', 'C', 'RW'], D: ['LD', 'RD'] };
function gameLines() {
  try { const l = JSON.parse(S.game.lines); if (l?.F && l?.D) return l; } catch {}
  return structuredClone(EMPTY_LINES);
}
function saveLines(l) {
  S.game.lines = JSON.stringify(l);
  queue({ key: 'lines', method: 'PATCH', url: `/api/games/${S.game.id}`, body: { lines: S.game.lines } });
  cache();
}
function linesCard() {
  const l = gameLines();
  const cell = (k, i, j, id) => `<button class="slot ${id ? 'set' : ''}" data-act="slot" data-id="${k}:${i}:${j}"><small>${SLOTS[k][j]}</small>${id ? esc(first(id)) : '+'}</button>`;
  const rows = (k) => l[k].map((ln, i) => `<div class="lrow"><b>${k}${i + 1}</b><div class="lslots c${ln.length}">${ln.map((id, j) => cell(k, i, j, id)).join('')}</div><button class="btn sm danger" data-act="dropline" data-id="${k}:${i}">✕</button></div>`).join('');
  const used = new Set([...l.F.flat(), ...l.D.flat()].filter(Boolean));
  const spare = S.players.filter((p) => p.position !== 'G' && !used.has(p.id));
  return `<div class="card glass"><h3>Lines this game</h3>${rows('F')}<button class="btn sm" data-act="addline" data-id="F" style="margin:4px 0 10px">+ Forward line</button>${rows('D')}<button class="btn sm" data-act="addline" data-id="D" style="margin-top:4px">+ D pair</button>
    ${spare.length ? `<div class="hint" style="margin-top:10px">Not in a line: ${spare.map((p) => esc(first(p.id))).join(', ')}</div>` : ''}</div>`;
}
function pickerOverlay() {
  if (!S.pick) return '';
  const [k, i, j] = S.pick; const l = gameLines();
  const where = new Map(); for (const kk of ['F', 'D']) l[kk].forEach((ln, ii) => ln.forEach((id) => id && where.set(id, `${kk}${ii + 1}`)));
  const want = (p) => (k === 'D' ? p.position === 'D' : p.position !== 'D' && p.position !== 'G');
  const list = [...S.players.filter(want), ...S.players.filter((p) => !want(p) && p.position !== 'G')];
  return `<div class="overlay" data-act="pickcancel"><div class="sheet glass" data-keep="1"><h3>${k}${+i + 1} · ${SLOTS[k][j]}</h3>
    <div class="chips" style="max-height:50vh;overflow:auto">${list.map((p) => `<div class="chip ${where.has(p.id) ? 'dim' : ''}" data-act="pickplayer" data-id="${p.id}">${esc(p.number ? '#' + p.number + ' ' : '')}${esc(first(p.id))} <span class="meta">${esc(p.position)}${where.has(p.id) ? ' · ' + where.get(p.id) : ''}</span></div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="pickcancel" style="flex:1">Cancel</button><button class="btn danger" data-act="pickplayer" data-id="0" style="flex:1">Clear slot</button></div></div></div>`;
}

function statPickOverlay() {
  if (!S.statPick) return '';
  const grp = [['Centers', (p) => p.position === 'C'], ['Forwards', (p) => p.position === 'F' || p.position === 'W'], ['Defense', (p) => p.position === 'D'], ['Goalies', (p) => p.position === 'G']];
  const seen = new Set();
  const sect = ([t, f]) => { const l = S.players.filter(f); l.forEach((p) => seen.add(p.id)); return l.length ? `<h3>${t}</h3><div class="chips">${l.map((p) => `<div class="chip ${p.focus ? 'focus' : ''} ${S.statSel === p.id ? 'on' : ''}" data-act="statsel" data-id="${p.id}">${esc(p.number ? '#' + p.number + ' ' : '')}${esc(first(p.id))}</div>`).join('')}</div>` : ''; };
  const body = grp.map(sect).join('');
  const rest = S.players.filter((p) => !seen.has(p.id));
  return `<div class="overlay" data-act="statpickcancel"><div class="sheet glass" data-keep="1"><div class="chips" style="margin-bottom:8px"><div class="chip ${S.statSel ? '' : 'on'}" data-act="statsel" data-id="0">Unknown</div></div>
    <div style="max-height:60vh;overflow:auto">${body}${rest.length ? `<h3>Other</h3><div class="chips">${rest.map((p) => `<div class="chip" data-act="statsel" data-id="${p.id}">${esc(first(p.id))}</div>`).join('')}</div>` : ''}</div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="statpickcancel" style="flex:1">Cancel</button></div></div></div>`;
}

function iceView() {
  const sh = computeShifts(S.events, S.game, rem()); const on = onIceSet(S.events);
  return `${linesCard()}<div class="hint" style="margin-bottom:8px">${clockOn(S.game) ? 'Tap = on/off ice (game clock). Hold = note about player. Clock must be running for time to accumulate.' : 'Tap = on/off ice. Hold = note about player. Clock is off, so shift times are real (wall) time.'}</div>
  <div class="grid g3">${S.players.map((p) => {
    const s = sh[p.id]; const open = s?.list.find((x) => x.open);
    return `<div class="pl ${on.has(p.id) ? 'on' : ''} ${p.focus ? 'focus' : ''}" data-act="shift" data-lp="note" data-id="${p.id}">
      <div class="n">${esc(p.number || '·')}</div><div class="nm">${S.nameMode === 'num' ? '' : esc(short(p, 'name').replace(/ #\S+$/, '')) + ' '}${esc(p.position)}</div>
      <div class="tm" ${open && clockOn(S.game) ? `data-start="${open.start}" data-per="${S.game.period}"` : ''}>${!clockOn(S.game) ? (s ? 'TOI ' + fmt(s.wall) : '') : open ? fmt(open.dur) : s ? 'TOI ' + fmt(s.toi) : ''}</div></div>`;
  }).join('')}</div>
  <div class="row" style="margin-top:12px"><button class="btn" data-act="alloff" style="flex:1">Everyone off ice (${on.size} on)</button></div>`;
}

function foView() {
  const cs = foPlayers(); if (S.foSel === null || (S.foSel !== 0 && !cs.find((c) => c.id === S.foSel))) S.foSel = cs[0]?.id ?? 0;
  const fos = S.events.filter((e) => e.type === 'faceoff');
  const stat = (id) => { const l = fos.filter((e) => (e.player_id ?? 0) === id); const w = l.filter((e) => e.data.result.endsWith('win')).length; return [w, l.length]; };
  const z = [['O', 'Off zone'], ['N', 'Neutral'], ['D', 'Def zone']];
  const btn = (r, c) => { const n = fos.filter((e) => e.data.result === r && (e.player_id ?? 0) === S.foSel).length; return `<button class="btn big ${c}" data-act="fo" data-id="${r}">${RESULTS[r]}<small>${n}</small></button>`; };
  const chip = (c) => `<div class="chip ${S.foSel === c.id ? 'on' : ''}" data-act="focenter" data-id="${c.id}">${esc(short(c))}</div>`;
  const cen = centers(); const fwd = forwards();
  const sect = (t, l, extra = '') => (l.length || extra ? `<h3 style="margin-top:10px">${t}</h3><div class="chips">${l.map(chip).join('')}${extra}</div>` : '');
  const other = `<div class="chip ${S.foSel === 0 ? 'on' : ''}" data-act="focenter" data-id="0">Other</div>`;
  const bp = faceoffByPeriod(S.events); const pc = S.foFmt === 'pct';
  const cell = (c) => (c ? (pc ? `${Math.round((100 * c[0]) / c[1])}%` : `${c[0]}/${c[1]}`) : '–');
  const names = Object.fromEntries(cs.map((c) => [c.id, c.name])); names[0] = 'Other';
  const tm = {}; for (const r of Object.values(bp.rows)) for (const [k, c] of Object.entries(r)) { const t = (tm[k] ||= [0, 0]); t[0] += c[0]; t[1] += c[1]; }
  const byPeriod = bp.periods.length ? `<div class="card glass" style="margin-top:14px"><div class="row" style="justify-content:space-between;align-items:center"><h3>By period</h3>
    <div class="seg"><button class="${pc ? '' : 'on'}" data-act="fofmt" data-id="ratio">W/T</button><button class="${pc ? 'on' : ''}" data-act="fofmt" data-id="pct">%</button></div></div>
    <table><tr><th></th>${bp.periods.map((p) => `<th>${periodLabel(p)}</th>`).join('')}<th>Game</th></tr>
    ${Object.entries(bp.rows).map(([id, r]) => `<tr><td>${esc(names[id] || pname(+id))}</td>${bp.periods.map((p) => `<td>${cell(r[p])}</td>`).join('')}<td>${cell(r.all)}</td></tr>`).join('')}
    <tr><td><b>Team</b></td>${bp.periods.map((p) => `<td><b>${cell(tm[p])}</b></td>`).join('')}<td><b>${cell(tm.all)}</b></td></tr></table></div>` : '';
  return `${cen.length || fwd.length ? sect('Centers', cen) + sect('Forwards', fwd, other) : sect('Players', cs, other)}
  <h3 style="margin-top:14px">Zone</h3><div class="seg">${z.map(([k, l]) => `<button class="${S.foZone === k ? 'on' : ''}" data-act="fozone" data-id="${k}">${l}</button>`).join('')}</div>
  <div class="grid g2" style="margin-top:14px">${btn('clean_win', 'win')}${btn('scrappy_win', 'swin')}${btn('scrappy_loss', 'sloss')}${btn('clean_loss', 'loss')}</div>
  <div class="card glass" style="margin-top:14px"><h3>Face-off wins</h3><table>${[...cs, { id: 0, name: 'Other' }].map((c) => { const [w, t] = stat(c.id); return t ? `<tr><td>${esc(c.name)}</td><td>${w}/${t}</td><td>${Math.round((100 * w) / t)}%</td></tr>` : ''; }).join('') || '<tr><td class="hint">None yet</td></tr>'}</table></div>${byPeriod}`;
}

function statsView() {
  if (S.statSel && !S.players.find((p) => p.id === S.statSel)) S.statSel = 0;
  const mine = S.events.filter((e) => e.type === 'stat' && (e.player_id ?? 0) === S.statSel && STATS[e.data.stat]);
  const sel = S.players.find((p) => p.id === S.statSel);
  const { team } = computeGame(S.game, S.players, S.events, rem());
  const tc = { goal_for: team.gf, goal_against: team.ga, shot_for: team.sf, shot_against: team.sa, pen_for: team.pen_for, pen_against: team.pen_against };
  const teamStats = S.events.filter((e) => e.type === 'stat' && e.player_id == null && TEAM_STATS[e.data.stat]);
  const tcount = (k) => teamStats.filter((e) => e.data.stat === k).length;
  return `<button class="btn big playerbtn ${sel ? 'on' : ''}" data-act="statpick">${sel ? esc((sel.number ? '#' + sel.number + ' ' : '') + sel.name) : 'Unknown player'}<small>${sel ? esc(sel.position) + ' · tap to change' : 'tap to choose player'}</small></button>
  <div class="grid g3">${Object.entries(STATS).map(([k, l]) => `<button class="btn big" data-act="stat" data-lp="statnote" data-id="${k}">${l}<small>${mine.filter((e) => e.data.stat === k).length}</small></button>`).join('')}</div>
  <div class="hint" style="margin:6px 2px 14px">Tap +1 · hold to add a note about it.</div>
  <h3>Team</h3><div class="grid g2">${Object.entries(TEAM_STATS).map(([k, l]) => `<button class="btn big" data-act="tstat" data-id="${k}">${l}<small>${tcount(k)}</small></button>`).join('')}</div>`;
}

function logView() {
  const f = S.logFilter; const list = S.events.slice().reverse().filter((e) => f === 'all' || (f === 'notes' ? e.type === 'note' : e.type !== 'note'));
  const foNum = new Map(faceoffSequence(S.events).map((e) => [e.cid, `${e.seq} (${periodLabel(e.period)} ${e.period_seq})`]));
  const label = (e) => {
    if (e.type === 'note') return esc(e.data.text);
    if (e.type === 'faceoff') return `Faceoff #${foNum.get(e.cid)} ${esc(e.player_id ? pname(e.player_id) : 'Other')} — ${RESULTS[e.data.result]} (${e.data.zone})`;
    if (e.type === 'stat') return `${esc(e.player_id ? pname(e.player_id) : 'Team')}: ${STATS[e.data.stat] || TEAM_STATS[e.data.stat]}`;
    if (e.type === 'shift_on') return `${esc(pname(e.player_id))} on`;
    if (e.type === 'shift_off') return `${esc(pname(e.player_id))} off`;
    return 'Period ended';
  };
  return `<div class="seg" style="margin-bottom:10px">${['all', 'notes', 'other'].map((k) => `<button class="${f === k ? 'on' : ''}" data-act="logf" data-id="${k}">${k}</button>`).join('')}</div>
  <div class="card glass" style="padding:0">${list.map((e) => `<div class="note row"><div style="flex:1" ${e.type === 'note' ? `data-act="editnote" data-id="${e.cid}"` : ''}><span class="pill">${tstamp(S.game, e)}</span>${label(e)}</div><button class="btn sm danger" data-act="del" data-id="${e.cid}">✕</button></div>`).join('') || '<div class="note hint">Empty.</div>'}</div>`;
}

function moreView() {
  const g = S.game;
  return `${g ? `<div class="card glass"><h3>This game</h3><div class="row" style="flex-wrap:wrap">
      <button class="btn" data-act="export">Show markdown</button>
      <button class="btn" data-act="download">Download .md</button>
      <button class="btn" data-act="clockpower">Clock: ${clockOn(g) ? 'On' : 'Off'}</button>
      <button class="btn" data-act="finish">${g.status === 'final' ? 'Reopen' : 'End game'}</button></div>
      ${S.exportText ? `<pre>${esc(S.exportText)}</pre>` : ''}</div>` : ''}
  <div class="card glass"><h3>New game</h3><div class="grid">
    <input id="g_opp" placeholder="Opponent"><div class="grid g2"><input id="g_date" type="date" value="${new Date().toISOString().slice(0, 10)}"><input id="g_len" type="number" value="15" inputmode="numeric" placeholder="Period min"></div>
    <input id="g_loc" placeholder="Location (optional)"><label class="hint row"><input type="checkbox" id="g_clk" ${S.clockDefault ? 'checked' : ''} style="width:auto"> Use game clock (periods are always tracked)</label><button class="btn pri" data-act="newgame">Start game</button></div></div>
  <div class="card glass"><h3>Games</h3>${S.games.map((x) => `<div class="note row"><div style="flex:1">${esc(x.date)} vs ${esc(x.opponent)} <span class="meta">${x.status}</span></div><button class="btn sm" data-act="opengame" data-id="${x.id}">Open</button></div>`).join('') || '<div class="hint">None yet.</div>'}</div>
  <div class="card glass"><h3>Roster</h3>${S.players.map((p) => `<div class="note row"><input class="pnum" data-pf="number" data-id="${p.id}" value="${esc(p.number)}" placeholder="#" inputmode="numeric"><div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
    <select class="ppos" data-pf="position" data-id="${p.id}">${['', 'C', 'F', 'D', 'G'].map((o) => `<option value="${o}" ${p.position === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}</select>
    <button class="btn sm" data-act="star" data-id="${p.id}">${p.focus ? '★' : '☆'}</button><button class="btn sm danger" data-act="delplayer" data-id="${p.id}">✕</button></div>`).join('')}
    <div class="grid" style="margin-top:10px"><div class="grid g3" style="grid-template-columns:2fr 1fr 1fr"><input id="p_name" placeholder="Name"><input id="p_num" placeholder="#" inputmode="numeric"><select id="p_pos"><option>C</option><option>F</option><option>D</option><option>G</option></select></div>
    <label class="hint row"><input type="checkbox" id="p_focus" style="width:auto"> Focus player (★ your son — pinned first)</label><button class="btn pri" data-act="addplayer">Add player</button></div></div>
  <div class="card glass"><h3>Import roster (TeamSnap)</h3>
    <div class="hint" style="margin-bottom:8px">TeamSnap → Roster → select all, copy, paste here. Only names, #s and positions are kept; parent contact info is discarded on your phone and never uploaded.</div>
    <textarea id="imp" style="min-height:90px;font-size:14px" placeholder="Paste roster here…">${esc(S.impText)}</textarea>
    <button class="btn" data-act="imppreview" style="margin-top:8px;width:100%">Preview</button>
    ${S.impRows.length ? `<div style="margin-top:10px">${S.impRows.map((r, i) => `<div class="note row"><div style="flex:1">${esc(r.number ? '#' + r.number + ' ' : '')}${esc(r.name)} <span class="meta">${esc(r.position || '—')}</span></div><button class="btn sm" data-act="impstar" data-id="${i}">${r.focus ? '★' : '☆'}</button><button class="btn sm danger" data-act="impdrop" data-id="${i}">✕</button></div>`).join('')}
    <button class="btn pri" data-act="impgo" style="margin-top:10px;width:100%">Import ${S.impRows.length} players</button></div>` : ''}</div>
  <div class="card glass"><h3>Claude / Obsidian</h3><div class="hint">MCP endpoint: <b>${location.origin}/mcp</b><br>Add: <code>claude mcp add --transport http hockey ${location.origin}/mcp</code></div></div>`;
}

const CLK_COLS = [[0, 1], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], null, [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]];
function clockOverlay() {
  if (!S.clk) return '';
  const d = S.clk; let di = 0;
  const cols = CLK_COLS.map((c) => {
    if (!c) return '<div class="colon">:</div>';
    const i = di++;
    return `<div class="dcol">${c.map((n) => `<button class="dig ${d[i] === n ? 'on' : ''}" data-act="clkdig" data-id="${i}:${n}">${n}</button>`).join('')}</div>`;
  }).join('');
  return `<div class="clkedit glass"><div class="dcols">${cols}</div>
    <div class="clkbtns"><button class="btn pri" data-act="clkset">Set</button><button class="btn" data-act="clkcancel">Cancel</button></div></div>`;
}

function render() {
  const keep = $('#main')?.scrollTop || 0;
  const body = !S.game && S.tab !== 'more' ? moreView() : ({ notes: notesView, ice: iceView, faceoff: foView, stats: statsView, log: logView, more: moreView }[S.tab])();
  $('#app').innerHTML = header() + clockBar() + clockOverlay() + `<main id="main">${body}</main>` + nav() + pickerOverlay() + (S.tab === 'stats' ? statPickOverlay() : '');
  $('#main').scrollTop = keep; syncBadge();
}

function tick() {
  if (!S.game) return;
  const g = S.game; const r = rem();
  const c = $('#clk'); if (c) c.textContent = fmt(r);
  document.querySelectorAll('.pl .tm[data-start]').forEach((el) => { if (+el.dataset.per === g.period) el.textContent = fmt(+el.dataset.start - r); });
  if (g.clock_since && r <= 0) { setClock({ clock_s: 0, clock_since: null }); toast('Period over — tap the period pill to advance'); render(); }
}
setInterval(tick, 250);

// ---------- actions ----------
function closeShifts(stamp) { for (const id of onIceSet(S.events)) addEvent('shift_off', id, {}, stamp); }
function saveNote() {
  const ta = $('#nt'); const text = (ta?.value || S.composer.text).trim();
  if (!text) return;
  const c = S.composer;
  const e = addEvent('note', null, { text, about: [...c.about], on_ice: [...onIceSet(S.events)], source: c.voice ? 'voice' : 'typed' }, c.stamp || snap());
  S.composer = { text: '', about: new Set(), stamp: null, voice: false };
  render(); undoable('Note saved', e);
}
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = $('#nt'); const c = S.composer;
  if (rec) { rec.stop(); return; }
  if (!SR) { toast('Voice needs HTTPS. Use the 🎙 on your keyboard instead.'); ta.focus(); return; }
  c.stamp ||= snap(); c.voice = true;
  const base = ta.value + (ta.value && !/\s$/.test(ta.value) ? ' ' : '');
  rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; ta.value = base + t; c.text = ta.value; };
  rec.onerror = (ev) => toast('Mic: ' + ev.error);
  rec.onend = () => { rec = null; $('#mic')?.classList.remove('rec'); if (S.autosave && (ta?.value || '').trim()) saveNote(); };
  rec.start(); $('#mic').classList.add('rec');
}
function noteAbout(pid, prefix = '') {
  S.composer.about = new Set(pid ? [pid] : []); S.composer.text = prefix; S.composer.stamp = snap(); S.tab = 'notes'; render(); $('#nt').focus();
}
async function api(method, url, body) {
  let r;
  try { r = await net(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
  catch (err) { throw Object.assign(new Error('No connection — this needs internet'), { net: isNet(err) }); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function loadGame(id) {
  let d;
  try { d = await api('GET', `/api/games/${id}`); }
  catch (err) { d = err.net && ls.get(`ht_g${id}`); if (!d) throw err; toast('Offline — showing copy saved on this device'); }
  S.game = d.game; S.events = d.events; ls.set('ht_game', id); cache();
}

const A = {
  tab: (id) => { S.tab = id; },
  namemode: () => { const i = NAME_MODES.findIndex(([k]) => k === S.nameMode); S.nameMode = NAME_MODES[(i + 1) % NAME_MODES.length][0]; ls.set('ht_name_mode', S.nameMode); },
  about: (id, el) => { const n = +id; S.composer.about.has(n) ? S.composer.about.delete(n) : S.composer.about.add(n); el.classList.toggle('on'); return false; },
  mic: () => { toggleMic(); return false; },
  savenote: () => { saveNote(); return false; },
  clock: () => { toggleClock(); },
  clockpower: () => {
    const g = S.game; const on = clockOn(g); S.clk = null;
    if (on) setClock({ clock_s: rem(), clock_since: null, clock_enabled: 0 }); else setClock({ clock_enabled: 1 });
    S.clockDefault = !on; ls.set('ht_clock_default', S.clockDefault);
  },
  editclock: () => {
    if (S.clk) { S.clk = null; return; }
    S.perMenu = false;
    const t = Math.round(rem()); const m = Math.floor(t / 60); const s = t % 60;
    S.clk = [Math.floor(m / 10) % 2, m % 10, Math.floor(s / 10), s % 10];
  },
  slot: (id) => { S.pick = id.split(':'); },
  pickcancel: () => { S.pick = null; },
  pickplayer: (id) => {
    const [k, i, j] = S.pick; const pid = +id; const l = gameLines(); S.pick = null;
    if (pid) for (const kk of ['F', 'D']) l[kk].forEach((ln) => ln.forEach((x, jj) => { if (x === pid) ln[jj] = null; }));
    l[k][+i][+j] = pid || null; saveLines(l);
  },
  addline: (k) => { const l = gameLines(); l[k].push(Array(SLOTS[k].length).fill(null)); saveLines(l); },
  dropline: (id) => { const [k, i] = id.split(':'); const l = gameLines(); l[k].splice(+i, 1); saveLines(l); },
  clkdig: (id) => { const [i, n] = id.split(':').map(Number); S.clk[i] = n; },
  clkcancel: () => { S.clk = null; },
  clkset: () => {
    const [a, b, c, d] = S.clk; S.clk = null;
    setClock({ clock_s: (a * 10 + b) * 60 + c * 10 + d, clock_since: S.game.clock_since ? Date.now() : null });
  },
  permenu: () => { S.perMenu = !S.perMenu; },
  period: (id) => {
    const g = S.game; const p = +id; S.perMenu = false;
    if (p === g.period) return;
    if (p > g.period) { const st = snap(); closeShifts(st); addEvent('period_end', null, {}, st); }
    setClock({ period: p, clock_s: g.period_len, clock_since: null });
  },
  shift: (id) => {
    const pid = +id; const on = onIceSet(S.events).has(pid);
    addEvent(on ? 'shift_off' : 'shift_on', pid);
    navigator.vibrate?.(15);
  },
  alloff: () => { closeShifts(snap()); },
  focenter: (id) => { S.foSel = +id; },
  fofmt: (id) => { S.foFmt = id; },
  fozone: (id) => { S.foZone = id; },
  fo: (r) => {
    const e = addEvent('faceoff', S.foSel || null, { result: r, zone: S.foZone });
    navigator.vibrate?.(15); render(); undoable(`${S.foSel ? first(S.foSel) : 'Other'}: ${RESULTS[r]}`, e); return false;
  },
  statpick: () => { S.statPick = true; },
  statpickcancel: () => { S.statPick = false; },
  statsel: (id) => { S.statSel = +id; S.statPick = false; },
  stat: (k) => { const who = S.statSel ? first(S.statSel) : 'Unknown'; const e = addEvent('stat', S.statSel || null, { stat: k }); S.statSel = 0; navigator.vibrate?.(15); render(); undoable(`${who} +${STATS[k]}`, e); return false; },
  tstat: (k) => { const e = addEvent('stat', null, { stat: k }); render(); undoable(TEAM_STATS[k], e); return false; },
  logf: (id) => { S.logFilter = id; },
  del: (cid) => { removeEvent(cid); },
  editnote: (cid) => { const e = S.events.find((x) => x.cid === cid); const t = prompt('Edit note', e.data.text); if (t == null) return false; e.data.text = t; queue({ method: 'PATCH', url: `/api/events/${cid}`, body: { data: { text: t } } }); cache(); },
  export: async () => { S.exportText = gameMarkdown(S.game, S.players, S.events, rem()); try { await navigator.clipboard.writeText(S.exportText); toast('Copied to clipboard'); } catch {} },
  download: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gameMarkdown(S.game, S.players, S.events, rem())], { type: 'text/markdown' }));
    a.download = `game-${S.game.id}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return false;
  },
  finish: async () => {
    const g = S.game;
    if (g.status !== 'final') { const st = snap(); closeShifts(st); setClock({ status: 'final', clock_s: rem(), clock_since: null }); } else setClock({ status: 'active' });
  },
  newgame: async () => {
    const body = { opponent: $('#g_opp').value.trim() || 'Opponent', date: $('#g_date').value, location: $('#g_loc').value, period_len: (+$('#g_len').value || 15) * 60, clock_enabled: $('#g_clk').checked ? 1 : 0 };
    let g;
    try { g = await api('POST', '/api/games', body); }
    catch (err) {
      if (!err.net) throw err;
      // offline: build the game locally; it is created on the server (first in the outbox) when we reconnect
      g = { ...body, id: -Date.now(), status: 'active', period: 1, clock_s: body.period_len, clock_since: null, lines: '', created_at: Date.now() };
      queue({ method: 'POST', url: '/api/games', body, tmp: g.id });
    }
    S.clockDefault = $('#g_clk').checked; ls.set('ht_clock_default', S.clockDefault);
    S.games.unshift(g); await loadGame(g.id); S.tab = 'notes'; S.composer = { text: '', about: new Set(), stamp: null, voice: false };
  },
  opengame: async (id) => { await loadGame(id); S.tab = 'notes'; S.exportText = ''; },
  addplayer: async () => {
    const name = $('#p_name').value.trim(); if (!name) return false;
    await api('POST', '/api/players', { name, number: $('#p_num').value, position: $('#p_pos').value, focus: $('#p_focus').checked }); await loadPlayers();
  },
  imppreview: () => { S.impText = $('#imp').value; S.impRows = parseRoster(S.impText); if (!S.impRows.length) toast('Nothing recognised — paste the full TeamSnap list'); },
  impstar: (i) => { const r = S.impRows[+i]; const was = r.focus; S.impRows.forEach((x) => (x.focus = false)); r.focus = !was; },
  impdrop: (i) => { S.impRows.splice(+i, 1); },
  impgo: async () => {
    const r = await api('POST', '/api/players', S.impRows);
    await loadPlayers(); S.impRows = []; S.impText = '';
    toast(`Imported ${r.added}${r.skipped ? `, skipped ${r.skipped} already on roster` : ''}`);
  },
  star: (id) => { const p = S.players.find((x) => x.id === +id); p.focus = p.focus ? 0 : 1; queue({ key: `p${id}:focus`, method: 'PATCH', url: `/api/players/${id}`, body: { focus: p.focus } }); cache(); },
  delplayer: (id) => {
    if (!confirm('Remove player?')) return false;
    S.players = S.players.filter((x) => x.id !== +id); queue({ method: 'DELETE', url: `/api/players/${id}`, body: {} }); cache();
  },
};
const LP = {
  note: (el) => noteAbout(+el.dataset.id),
  statnote: (el) => { noteAbout(S.statSel, `${STATS[el.dataset.id]}: `); S.statSel = 0; },
};

// click + long press
let lpTimer = null; let lpFired = false; let lpStart = null;
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-lp]'); lpFired = false; if (!el) return;
  lpStart = [e.clientX, e.clientY];
  lpTimer = setTimeout(() => { lpFired = true; navigator.vibrate?.(30); LP[el.dataset.lp](el); render(); }, 450);
});
const cancelLp = () => clearTimeout(lpTimer);
document.addEventListener('pointerup', cancelLp); document.addEventListener('pointercancel', cancelLp);
document.addEventListener('pointermove', (e) => { if (lpStart && Math.hypot(e.clientX - lpStart[0], e.clientY - lpStart[1]) > 10) cancelLp(); });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.classList.contains('overlay') && e.target !== el) return;
  if (lpFired) { lpFired = false; return; }
  try {
    const r = await A[el.dataset.act](el.dataset.id, el);
    if (r !== false) render();
  } catch (err) { toast('Error: ' + err.message); }
});
document.addEventListener('change', (e) => {
  const f = e.target.dataset?.pf; if (!f) return;
  const id = +e.target.dataset.id; const v = e.target.value.trim();
  const p = S.players.find((x) => x.id === id); if (!p) return;
  p[f] = v; S.players = sortPlayers(S.players);
  queue({ key: `p${id}:${f}`, method: 'PATCH', url: `/api/players/${id}`, body: { [f]: v } });
  cache(); render();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'nt') { S.composer.text = e.target.value; S.composer.stamp ||= snap(); }
  if (e.target.id === 'auto') { S.autosave = e.target.checked; ls.set('ht_autosave', S.autosave); }
});

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict saved games/outbox
  const c = ls.get('ht_cache');
  if (c) Object.assign(S, { players: sortPlayers(c.players || []), games: c.games || [], game: c.game, events: c.events || [] });
  render();
  await flush();
  if (S.outbox.length) return render(); // unsynced local changes are newer than the server; don't overwrite them
  try {
    await loadPlayers(); S.games = await api('GET', '/api/games');
    const want = S.games.find((g) => g.id === ls.get('ht_game')) || S.games.find((g) => g.status === 'active') || S.games[0];
    if (want) await loadGame(want.id);
    cache();
  } catch {}
  if (!S.players.length || !S.game) S.tab = 'more';
  render();
}
boot();
