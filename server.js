import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { computeGame, gameMarkdown, faceoffSequence, periodLabel, fmt, tstamp, RESULTS } from './public/summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'hockey.db');
const MCP_TOKEN = process.env.MCP_TOKEN || '';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, number TEXT DEFAULT '', position TEXT DEFAULT '',
  focus INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY, opponent TEXT NOT NULL, date TEXT, location TEXT DEFAULT '',
  status TEXT DEFAULT 'active', period INTEGER DEFAULT 1, period_len INTEGER DEFAULT 900,
  clock_s REAL DEFAULT 900, clock_since INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, cid TEXT UNIQUE, game_id INTEGER NOT NULL, type TEXT NOT NULL,
  period INTEGER NOT NULL, remaining REAL NOT NULL, wall_ts INTEGER NOT NULL,
  player_id INTEGER, data TEXT DEFAULT '{}');
CREATE INDEX IF NOT EXISTS ev_game ON events(game_id, id);
`);
try { db.exec("ALTER TABLE games ADD COLUMN lines TEXT DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE games ADD COLUMN clock_enabled INTEGER DEFAULT 1'); } catch {}

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

const evOut = (r) => ({ ...r, data: JSON.parse(r.data || '{}') });
const getEvents = (gid) => {
  const evs = q('SELECT * FROM events WHERE game_id=? ORDER BY id', gid).map(evOut);
  const fo = new Map(faceoffSequence(evs).map((e) => [e.cid, e]));
  return evs.map((e) => (fo.has(e.cid) ? fo.get(e.cid) : e));
};
const getPlayers = () => q(`SELECT * FROM players WHERE active=1 ORDER BY CASE position WHEN 'C' THEN 0 WHEN 'W' THEN 1 WHEN 'F' THEN 1 WHEN 'D' THEN 2 WHEN 'G' THEN 3 ELSE 4 END, CAST(number AS INTEGER), name`);
const curRem = (g) => (g.clock_since ? Math.max(0, g.clock_s - (Date.now() - g.clock_since) / 1000) : g.clock_s);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (c) => (s += c));
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});

const GAME_FIELDS = ['opponent', 'date', 'location', 'status', 'period', 'period_len', 'clock_s', 'clock_since', 'lines', 'clock_enabled'];
const PLAYER_FIELDS = ['name', 'number', 'position', 'focus'];
const patch = (table, id, body, fields) => {
  const keys = fields.filter((f) => f in body);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => body[k]), id);
};

// ---------- REST ----------
async function api(req, res, url) {
  const m = req.method; const p = url.pathname;
  let r;
  if (p === '/api/players' && m === 'GET') return json(res, 200, getPlayers());
  if (p === '/api/players' && m === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b)) {
      const have = new Set(getPlayers().map((x) => x.name.toLowerCase()));
      let added = 0;
      for (const x of b) {
        if (!x.name || have.has(x.name.toLowerCase())) continue;
        run('INSERT INTO players(name,number,position,focus) VALUES(?,?,?,?)', x.name, x.number || '', x.position || '', x.focus ? 1 : 0);
        have.add(x.name.toLowerCase()); added++;
      }
      return json(res, 200, { added, skipped: b.length - added });
    }
    if (!b.name) return json(res, 400, { error: 'name required' });
    const id = run('INSERT INTO players(name,number,position,focus) VALUES(?,?,?,?)', b.name, b.number || '', b.position || '', b.focus ? 1 : 0).lastInsertRowid;
    return json(res, 200, one('SELECT * FROM players WHERE id=?', id));
  }
  if ((r = p.match(/^\/api\/players\/(\d+)$/))) {
    if (m === 'PATCH') { patch('players', r[1], await readBody(req), PLAYER_FIELDS); return json(res, 200, one('SELECT * FROM players WHERE id=?', r[1])); }
    if (m === 'DELETE') { run('UPDATE players SET active=0 WHERE id=?', r[1]); return json(res, 200, { ok: true }); }
  }
  if (p === '/api/games' && m === 'GET') return json(res, 200, q('SELECT * FROM games ORDER BY date DESC, id DESC'));
  if (p === '/api/games' && m === 'POST') {
    const b = await readBody(req);
    const len = Number(b.period_len) || 900;
    const id = run('INSERT INTO games(opponent,date,location,period_len,clock_s,created_at,clock_enabled) VALUES(?,?,?,?,?,?,?)',
      b.opponent || 'Opponent', b.date || new Date().toISOString().slice(0, 10), b.location || '', len, len, Date.now(), b.clock_enabled === 0 || b.clock_enabled === false ? 0 : 1).lastInsertRowid;
    return json(res, 200, one('SELECT * FROM games WHERE id=?', id));
  }
  if ((r = p.match(/^\/api\/games\/(\d+)$/))) {
    const id = Number(r[1]);
    if (m === 'GET') {
      const game = one('SELECT * FROM games WHERE id=?', id);
      return game ? json(res, 200, { game, events: getEvents(id) }) : json(res, 404, { error: 'not found' });
    }
    if (m === 'PATCH') { patch('games', id, await readBody(req), GAME_FIELDS); return json(res, 200, one('SELECT * FROM games WHERE id=?', id)); }
    if (m === 'DELETE') { run('DELETE FROM events WHERE game_id=?', id); run('DELETE FROM games WHERE id=?', id); return json(res, 200, { ok: true }); }
  }
  if ((r = p.match(/^\/api\/games\/(\d+)\/events$/)) && m === 'POST') {
    const b = await readBody(req);
    const list = Array.isArray(b) ? b : [b];
    const tx = list.map((e) => {
      run(`INSERT OR IGNORE INTO events(cid,game_id,type,period,remaining,wall_ts,player_id,data) VALUES(?,?,?,?,?,?,?,?)`,
        e.cid, r[1], e.type, e.period, e.remaining, e.wall_ts || Date.now(), e.player_id ?? null, JSON.stringify(e.data || {}));
      return e.cid;
    });
    return json(res, 200, { ok: true, cids: tx });
  }
  if ((r = p.match(/^\/api\/events\/([\w-]+)$/))) {
    if (m === 'DELETE') { run('DELETE FROM events WHERE cid=?', r[1]); return json(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const b = await readBody(req);
      const ev = one('SELECT * FROM events WHERE cid=?', r[1]);
      if (ev) run('UPDATE events SET data=? WHERE cid=?', JSON.stringify({ ...JSON.parse(ev.data), ...b.data }), r[1]);
      return json(res, 200, { ok: true });
    }
  }
  if ((r = p.match(/^\/api\/games\/(\d+)\/export\.(md|json)$/)) && m === 'GET') {
    const game = one('SELECT * FROM games WHERE id=?', r[1]);
    if (!game) return json(res, 404, { error: 'not found' });
    if (r[2] === 'json') return json(res, 200, { game, players: getPlayers(), events: getEvents(game.id) });
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    return res.end(gameMarkdown(game, getPlayers(), getEvents(game.id), curRem(game)));
  }
  json(res, 404, { error: 'not found' });
}

// ---------- MCP (streamable HTTP, stateless JSON) ----------
const textResult = (t) => ({ content: [{ type: 'text', text: t }] });
const findGame = (id) => one('SELECT * FROM games WHERE id=?', id);
const pctS = (w, t) => (t ? `${Math.round((100 * w) / t)}%` : '–');

const TOOLS = [
  { name: 'list_games', description: 'List tracked hockey games (newest first) with score, note count and status.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: ({ limit = 20 }) => textResult(q('SELECT * FROM games ORDER BY date DESC, id DESC LIMIT ?', limit).map((g) => {
      const { team } = computeGame(g, getPlayers(), getEvents(g.id), curRem(g));
      const notes = one(`SELECT COUNT(*) c FROM events WHERE game_id=? AND type='note'`, g.id).c;
      return `#${g.id} ${g.date} vs ${g.opponent} — ${team.gf}-${team.ga} (${g.status}), ${notes} notes`;
    }).join('\n') || 'No games yet.') },
  { name: 'get_game', description: 'Full Obsidian-ready markdown for one game: raw timestamped notes by period (with who was on ice), full event timeline, per-player ice time/shift/face-off/stat table. Includes a Lines section (forward lines LW/C/RW and D pairs LD/RD) so references in notes like "line one", "second pair" or a player name plus "line" can be matched to players. Notes are intentionally uncategorized — categorize them yourself.',
    inputSchema: { type: 'object', properties: { game_id: { type: 'number' } }, required: ['game_id'] },
    run: ({ game_id }) => { const g = findGame(game_id); return textResult(g ? gameMarkdown(g, getPlayers(), getEvents(g.id), curRem(g)) : 'Game not found'); } },
  { name: 'search_notes', description: 'Search raw game notes across all games by text and/or player name (the note\'s "about" tags or on-ice list).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, player: { type: 'string' } } },
    run: ({ query = '', player = '' }) => {
      const players = getPlayers(); const pn = Object.fromEntries(players.map((p) => [p.id, p.name]));
      const want = player.toLowerCase(); const qq = query.toLowerCase();
      const out = [];
      for (const g of q('SELECT * FROM games ORDER BY date, id')) {
        for (const e of getEvents(g.id)) {
          if (e.type !== 'note') continue;
          const names = [...(e.data.about || []), ...(e.data.on_ice || [])].map((i) => pn[i] || '').join(' ').toLowerCase();
          if (qq && !e.data.text.toLowerCase().includes(qq)) continue;
          if (want && !names.includes(want) && !e.data.text.toLowerCase().includes(want)) continue;
          out.push(`${g.date} vs ${g.opponent} ${tstamp(g, e)}: ${e.data.text}`);
        }
      }
      return textResult(out.join('\n') || 'No matching notes.');
    } },
  { name: 'player_report', description: 'Cross-game report for one player: ice time, shifts, face-offs by zone, stat totals per game.',
    inputSchema: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
    run: ({ player }) => {
      const p = getPlayers().find((x) => x.name.toLowerCase().includes(player.toLowerCase()));
      if (!p) return textResult('Player not found');
      const lines = [`# ${p.name}`];
      for (const g of q('SELECT * FROM games ORDER BY date, id')) {
        const r = computeGame(g, [p], getEvents(g.id), curRem(g)).rows[0];
        lines.push(`${g.date} vs ${g.opponent}: TOI ${fmt(r.toi)} (wall ${fmt(r.wallToi)}), ${r.shifts} shifts, avg ${fmt(r.avgShift)}, FO ${r.fo.wins}/${r.fo.total} (${pctS(r.fo.wins, r.fo.total)}), stats ${JSON.stringify(r.stats)}`);
      }
      return textResult(lines.join('\n'));
    } },
  { name: 'faceoff_report', description: 'Face-off results per center (overall, by zone, clean vs scrappy), optionally for one game.',
    inputSchema: { type: 'object', properties: { game_id: { type: 'number' } } },
    run: ({ game_id }) => {
      const games = game_id ? [findGame(game_id)].filter(Boolean) : q('SELECT * FROM games');
      const tot = {};
      for (const g of games) for (const e of getEvents(g.id)) if (e.type === 'faceoff') {
        const n = e.player_id ? getPlayers().find((p) => p.id === e.player_id)?.name || '?' : 'Other';
        const t = (tot[n] ||= { n: 0, w: 0, r: {}, z: {} });
        t.n++; if (e.data.result.endsWith('win')) t.w++;
        t.r[e.data.result] = (t.r[e.data.result] || 0) + 1;
        const z = (t.z[e.data.zone] ||= [0, 0]); z[1]++; if (e.data.result.endsWith('win')) z[0]++;
      }
      const seqLines = [];
      for (const g of games) {
        const fos = faceoffSequence(getEvents(g.id)); if (!fos.length) continue;
        const pn = Object.fromEntries(getPlayers().map((p) => [p.id, p.name]));
        seqLines.push(`\nSequence #${g.id} vs ${g.opponent} (in order; later = later in period):`);
        for (const e of fos) seqLines.push(`${e.seq}. ${periodLabel(e.period)} ${e.period_seq}/${e.period_total} ${pn[e.player_id] || 'Other'} ${e.data.zone} ${e.data.result.endsWith('win') ? 'W' : 'L'}`);
      }
      return textResult(Object.entries(tot).map(([n, t]) => `${n}: ${t.w}/${t.n} (${pctS(t.w, t.n)}) | ${Object.entries(t.r).map(([k, v]) => `${RESULTS[k]} ${v}`).join(', ')} | zones ${Object.entries(t.z).map(([z, v]) => `${z} ${v[0]}/${v[1]}`).join(' ')}`).join('\n') + seqLines.join('\n') || 'No face-offs logged.');
    } },
];

async function mcp(req, res) {
  if (MCP_TOKEN && req.headers.authorization !== `Bearer ${MCP_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const msg = await readBody(req);
  const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  if (msg.id === undefined) { res.writeHead(202); return res.end(); }
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'hockeytracker', version: '0.1.0' } });
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === msg.params.name);
      if (!t) return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
      try { return reply(t.run(msg.params.arguments || {})); } catch (e) { return reply({ ...textResult(String(e)), isError: true }); }
    }
    case 'ping': return reply({});
    default: return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
}

// ---------- static ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serve(res, pathname) {
  const f = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': (MIME[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/mcp') return await mcp(req, res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serve(res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`hockeytracker on :${PORT} (db ${DB_PATH})`));
