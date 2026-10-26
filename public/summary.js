// Shared by server (exports, MCP) and browser (live views). Pure functions, no DOM/DB.
export const periodLabel = (p) => (p <= 3 ? `P${p}` : p === 4 ? 'OT' : 'SO');
export const fmt = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Period label, plus the game-clock time only when the game was tracked with the clock on. */
export const clockOn = (game) => game?.clock_enabled !== 0;
export const tstamp = (game, e) => (clockOn(game) || e.data?.timed ? `${periodLabel(e.period)} ${fmt(e.remaining)}` : periodLabel(e.period));

export const RESULTS = {
  clean_win: 'Clean win',
  scrappy_win: 'Scrappy win',
  scrappy_loss: 'Scrappy loss',
  clean_loss: 'Clean loss',
};
export const STATS = {
  shot: 'Shot', goal: 'Goal', assist: 'Assist', hit: 'Hit', takeaway: 'Takeaway',
  giveaway: 'Giveaway', block: 'Block', penalty: 'Penalty', good: 'Good play', bad: 'Mistake',
};
export const TEAM_STATS = {
  goal_for: 'Goal for', goal_against: 'Goal against', shot_for: 'Shot for',
  shot_against: 'Shot against', pen_for: 'Penalty on us', pen_against: 'Penalty on them',
};

/** Pair shift_on/shift_off per player. curRem = current clock remaining in game.period. */
export function computeShifts(events, game, curRem) {
  const out = {}; const open = {};
  const get = (id) => (out[id] ||= { list: [], toi: 0, wall: 0, open: false });
  for (const e of events) {
    if (e.type === 'shift_on' && e.player_id != null && !open[e.player_id]) {
      open[e.player_id] = e;
    } else if (e.type === 'shift_off' && open[e.player_id]) {
      const o = open[e.player_id]; delete open[e.player_id];
      const dur = Math.max(0, o.remaining - e.remaining);
      const wall = Math.max(0, (e.wall_ts - o.wall_ts) / 1000);
      const s = get(e.player_id);
      s.list.push({ period: o.period, start: o.remaining, end: e.remaining, dur, wall });
      s.toi += dur; s.wall += wall;
    }
  }
  const now = Date.now();
  for (const [pid, o] of Object.entries(open)) {
    const s = get(pid);
    const end = game && o.period === game.period && curRem != null ? curRem : o.remaining;
    const dur = Math.max(0, o.remaining - end);
    const wall = Math.max(0, (now - o.wall_ts) / 1000);
    s.list.push({ period: o.period, start: o.remaining, end, dur, wall, open: true });
    s.toi += dur; s.wall += wall; s.open = true;
  }
  return out;
}

export const onIceSet = (events) => {
  const s = new Set();
  for (const e of events) {
    if (e.type === 'shift_on') s.add(e.player_id);
    else if (e.type === 'shift_off') s.delete(e.player_id);
  }
  return s;
};

/**
 * Face-off order is the timeline when the clock isn't used: later in the order = later in the period.
 * Derived from event order (not stored) so undo/offline sync can't leave gaps. Returns a new array of
 * faceoff events with seq (game-wide, 1-based), period_seq (nth in its period) and period_total.
 */
export function faceoffSequence(events) {
  const fos = events.filter((e) => e.type === 'faceoff');
  const n = {}; const tot = {};
  for (const e of fos) tot[e.period] = (tot[e.period] || 0) + 1;
  return fos.map((e, i) => ({ ...e, seq: i + 1, period_seq: (n[e.period] = (n[e.period] || 0) + 1), period_total: tot[e.period] }));
}

/** Face-off wins/total per player and period: { [player_id|0]: { [period]: [w,t], all: [w,t] } }, plus periods list. */
export function faceoffByPeriod(events) {
  const out = {}; const periods = new Set();
  for (const e of events) {
    if (e.type !== 'faceoff') continue;
    periods.add(e.period);
    const row = (out[e.player_id ?? 0] ||= { all: [0, 0] });
    const w = e.data.result.endsWith('win') ? 1 : 0;
    for (const k of [e.period, 'all']) { const c = (row[k] ||= [0, 0]); c[0] += w; c[1]++; }
  }
  return { rows: out, periods: [...periods].sort((a, b) => a - b) };
}

const blankFo = () => ({ total: 0, wins: 0, clean_win: 0, scrappy_win: 0, scrappy_loss: 0, clean_loss: 0, zones: {} });
export function addFo(fo, e) {
  const r = e.data.result; const z = e.data.zone || '?';
  fo.total++; fo[r]++; if (r.endsWith('win')) fo.wins++;
  const zz = (fo.zones[z] ||= { total: 0, wins: 0 });
  zz.total++; if (r.endsWith('win')) zz.wins++;
}

export function computeGame(game, players, events, curRem) {
  const shifts = computeShifts(events, game, curRem);
  const per = {};
  const row = (id) => (per[id] ||= { stats: {}, fo: blankFo(), notes: 0 });
  const team = { gf: 0, ga: 0, sf: 0, sa: 0, pen_for: 0, pen_against: 0, fo: blankFo(), byPeriod: {} };
  const bp = (p) => (team.byPeriod[p] ||= { gf: 0, ga: 0, sf: 0, sa: 0 });
  for (const e of events) {
    if (e.type === 'stat') {
      const k = e.data.stat;
      if (e.player_id != null) {
        const r = row(e.player_id); r.stats[k] = (r.stats[k] || 0) + 1;
        if (k === 'goal') { team.gf++; team.sf++; bp(e.period).gf++; bp(e.period).sf++; }
        if (k === 'shot') { team.sf++; bp(e.period).sf++; }
        if (k === 'penalty') team.pen_for++;
      } else {
        const m = { goal_for: ['gf', 'sf'], goal_against: ['ga', 'sa'], shot_for: ['sf'], shot_against: ['sa'], goal: ['gf', 'sf'], shot: ['sf'] }[k];
        for (const f of m || []) { team[f]++; bp(e.period)[f]++; }
        if (k === 'pen_for' || k === 'penalty') team.pen_for++;
        if (k === 'pen_against') team.pen_against++;
      }
    } else if (e.type === 'faceoff') {
      addFo(team.fo, e);
      if (e.player_id != null) addFo(row(e.player_id).fo, e);
    } else if (e.type === 'note' && e.player_id != null) {
      row(e.player_id).notes++;
    }
  }
  const rows = players.map((p) => {
    const r = per[p.id] || { stats: {}, fo: blankFo(), notes: 0 };
    const sh = shifts[p.id] || { list: [], toi: 0, wall: 0 };
    return {
      player: p, stats: r.stats, fo: r.fo, notes: r.notes,
      toi: sh.toi, wallToi: sh.wall, shifts: sh.list.length,
      avgShift: sh.list.length ? sh.toi / sh.list.length : 0,
      longest: sh.list.reduce((m, s) => Math.max(m, s.dur), 0),
      shiftList: sh.list,
    };
  });
  return { team, rows };
}

const pct = (w, t) => (t ? `${Math.round((100 * w) / t)}%` : '–');
const foLine = (fo) => fo.total
  ? `${fo.wins}/${fo.total} (${pct(fo.wins, fo.total)}) — clean W ${fo.clean_win}, scrappy W ${fo.scrappy_win}, scrappy L ${fo.scrappy_loss}, clean L ${fo.clean_loss}`
    + ' | ' + Object.entries(fo.zones).map(([z, v]) => `${{ O: 'Off', D: 'Def', N: 'Neu' }[z] || z} ${v.wins}/${v.total}`).join(', ')
  : 'none';

export function gameMarkdown(game, players, events, curRem) {
  const pn = Object.fromEntries(players.map((p) => [p.id, p]));
  const nm = (id) => (id == null ? null : pn[id]?.name || `#${id}`);
  const { team, rows } = computeGame(game, players, events, curRem);
  const L = [];
  const clk = clockOn(game);
  L.push('---', 'type: hockey-game', `date: ${game.date || ''}`, `clock: ${clk ? 'on' : 'off'}`, `opponent: "${game.opponent}"`,
    `score: "${team.gf}-${team.ga}"`, `status: ${game.status}`, '---', '');
  L.push(`# Game vs ${game.opponent} — ${game.date || ''}`);
  if (game.location) L.push(`Location: ${game.location}`);
  L.push('', `**Score (as tracked):** ${team.gf}–${team.ga} | **Shots:** ${team.sf}–${team.sa} | **Penalties:** us ${team.pen_for}, them ${team.pen_against}`);
  L.push(`**Team face-offs:** ${foLine(team.fo)}`, '');

  let lines = null; try { lines = game.lines ? JSON.parse(game.lines) : null; } catch {}
  if (lines && [...(lines.F || []), ...(lines.D || [])].some((l) => l.some(Boolean))) {
    const slot = (id) => nm(id) || '—';
    L.push('## Lines', '_Line definitions for this game. Notes may refer to a line by number ("line one" = F1, "second pair" = D2) or by a member\'s name ("Brennan\'s line"); match those references to the players below._');
    (lines.F || []).forEach((l, i) => l.some(Boolean) && L.push(`- F${i + 1}: LW ${slot(l[0])} · C ${slot(l[1])} · RW ${slot(l[2])}`));
    (lines.D || []).forEach((l, i) => l.some(Boolean) && L.push(`- D${i + 1}: LD ${slot(l[0])} · RD ${slot(l[1])}`));
    L.push('');
  }
  L.push('## Notes by period (raw, uncategorized)');
  if (!clk) L.push('_Game clock was not used for this game; notes are tagged by period only. Any timing is in the note text._');
  const periods = [...new Set(events.map((e) => e.period))].sort((a, b) => a - b);
  let anyNote = false;
  for (const p of periods) {
    const ns = events.filter((e) => e.type === 'note' && e.period === p);
    if (!ns.length) continue;
    anyNote = true;
    L.push(`### ${periodLabel(p)}`);
    for (const e of ns) {
      const about = e.data.about?.length ? ` [about: ${e.data.about.map(nm).join(', ')}]` : '';
      const ice = e.data.on_ice?.length ? ` (on ice: ${e.data.on_ice.map(nm).join(', ')})` : '';
      const src = e.data.source === 'voice' ? ' 🎙' : '';
      L.push(`-${clk ? ` **${fmt(e.remaining)}**` : ''}${src}${about} ${e.data.text}${ice}`);
    }
    L.push('');
  }
  if (!anyNote) L.push('_No notes._', '');

  const fbp = faceoffByPeriod(events);
  if (fbp.periods.length) {
    const cell = (c) => (c ? `${c[0]}/${c[1]} (${pct(c[0], c[1])})` : '–');
    L.push('## Face-offs by period', '_Wins/total (win %) per player, by period._',
      `| Player | ${fbp.periods.map(periodLabel).join(' | ')} | Game |`, `|---|${fbp.periods.map(() => '---|').join('')}---|`);
    for (const [id, r] of Object.entries(fbp.rows)) L.push(`| ${+id ? nm(+id) : 'Other'} | ${fbp.periods.map((p) => cell(r[p])).join(' | ')} | ${cell(r.all)} |`);
    const tm = { all: [0, 0] };
    for (const r of Object.values(fbp.rows)) for (const [k, c] of Object.entries(r)) { const t = (tm[k] ||= [0, 0]); t[0] += c[0]; t[1] += c[1]; }
    L.push(`| **Team** | ${fbp.periods.map((p) => cell(tm[p])).join(' | ')} | ${cell(tm.all)} |`, '');
  }
  const foSeq = new Map(faceoffSequence(events).map((e) => [e.cid, e]));
  if (foSeq.size) {
    L.push('## Face-off sequence',
      '_Order in which face-offs were logged. Later in a period = later in the order, so late face-offs in a close game matter most. W/L is cumulative within the period._',
      '| Game # | Period # | Period | Center | Zone | Result | Period record |', '|---|---|---|---|---|---|---|');
    const rec = {};
    for (const e of foSeq.values()) {
      const r = (rec[e.period] ||= [0, 0]); r[1]++; if (e.data.result.endsWith('win')) r[0]++;
      L.push(`| ${e.seq} | ${e.period_seq}/${e.period_total} | ${periodLabel(e.period)} | ${nm(e.player_id) || 'other C'} | ${{ O: 'Off', D: 'Def', N: 'Neu' }[e.data.zone] || '?'} | ${RESULTS[e.data.result]} | ${r[0]}/${r[1]} |`);
    }
    L.push('');
  }
  L.push('## Full timeline');
  for (const e of events) {
    const t = tstamp(game, e);
    if (e.type === 'faceoff') L.push(`- ${t} faceoff #${foSeq.get(e.cid).seq} (${periodLabel(e.period)} ${foSeq.get(e.cid).period_seq}/${foSeq.get(e.cid).period_total}) — ${nm(e.player_id) || 'other C'}: ${RESULTS[e.data.result]} (${{ O: 'off zone', D: 'def zone', N: 'neutral' }[e.data.zone] || 'zone ?'})`);
    else if (e.type === 'stat') L.push(`- ${t} ${nm(e.player_id) || 'Team'}: ${STATS[e.data.stat] || TEAM_STATS[e.data.stat] || e.data.stat}`);
    else if (e.type === 'shift_on') L.push(`- ${t} ${nm(e.player_id)} on ice`);
    else if (e.type === 'shift_off') L.push(`- ${t} ${nm(e.player_id)} off ice`);
    else if (e.type === 'period_end') L.push(`- ${periodLabel(e.period)} ended`);
    else if (e.type === 'note') L.push(`- ${t} note: ${e.data.text}`);
  }
  L.push('', '## Player summary',
    clk ? '| Player | TOI (game clock) | TOI (wall) | Shifts | Avg shift | Longest | Faceoffs | Stats |' : '| Player | Faceoffs | Stats |',
    clk ? '|---|---|---|---|---|---|---|---|' : '|---|---|---|');
  for (const r of rows) {
    const st = Object.entries(r.stats).map(([k, v]) => `${STATS[k] || k} ${v}`).join(', ') || '–';
    if (!r.toi && !r.wallToi && !r.fo.total && st === '–' && !r.notes) continue;
    const who = `${r.player.name}${r.player.number ? ` #${r.player.number}` : ''}`;
    const fo = r.fo.total ? `${r.fo.wins}/${r.fo.total} (${pct(r.fo.wins, r.fo.total)})` : '–';
    if (!clk) { L.push(`| ${who} | ${fo} | ${st} |`); continue; }
    L.push(`| ${r.player.name}${r.player.number ? ` #${r.player.number}` : ''} | ${fmt(r.toi)} | ${fmt(r.wallToi)} | ${r.shifts} | ${fmt(r.avgShift)} | ${fmt(r.longest)} | ${r.fo.total ? `${r.fo.wins}/${r.fo.total} (${pct(r.fo.wins, r.fo.total)})` : '–'} | ${st} |`);
  }
  if (clk) L.push('', '_TOI by game clock only counts while the clock runs; wall TOI is real elapsed time on ice (includes stoppages)._');
  return L.join('\n');
}
