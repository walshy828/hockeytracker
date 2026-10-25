// Smoke test against a running server: BASE=http://localhost:3111 node test.js
const B = process.env.BASE || 'http://localhost:3111';
const j = async (m, u, b) => (await fetch(B + u, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) })).json();
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
const colin = await j('POST', '/api/players', { name: 'Colin Walsh', number: '9', position: 'C', focus: true });
const g = await j('POST', '/api/games', { opponent: 'Test Team', period_len: 900 });
const now = Date.now();
const ev = (cid, type, player_id, remaining, data = {}, wall = now) => ({ cid, type, player_id, period: 1, remaining, wall_ts: wall, data });
await j('POST', `/api/games/${g.id}/events`, [
  ev('a1', 'shift_on', colin.id, 900), ev('a2', 'shift_off', colin.id, 855, {}, now + 60000),
  ev('a3', 'faceoff', colin.id, 600, { zone: 'O', result: 'clean_win' }),
  ev('a3b', 'faceoff', colin.id, 300, { zone: 'D', result: 'clean_loss' }),
  ev('a4', 'note', null, 500, { text: 'Colin backchecking hard', about: [colin.id], on_ice: [colin.id], source: 'voice' }),
  ev('a5', 'stat', colin.id, 400, { stat: 'goal' }),
]);
await j('POST', `/api/games/${g.id}/events`, [ev('a1', 'shift_on', colin.id, 900)]); // dedupe
const d = await j('GET', `/api/games/${g.id}`);
assert(d.events.length === 6, 'dedupes by cid');
const md = await (await fetch(`${B}/api/games/${g.id}/export.md`)).text();
assert(md.includes('0:45') && md.includes('1/2 (50%)') && md.includes('backchecking') && md.includes('1–0'), 'markdown has TOI, FO%, note, score');
assert(d.events.filter((e) => e.type === 'faceoff').map((e) => e.seq + ':' + e.period_seq).join() === '1:1,2:2', 'faceoff seq on api');
assert(md.includes('## Face-off sequence') && md.includes('| 2 | 2/2 | P1 |'), 'markdown face-off sequence');
assert(md.includes('## Face-offs by period') && md.includes('| Colin Walsh | 1/2 (50%) | 1/2 (50%) |'), 'markdown by-period table');
const rpc = async (method, params) => (await (await fetch(B + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
assert((await rpc('tools/list')).tools.length >= 5, 'mcp lists tools');
assert((await rpc('tools/call', { name: 'search_notes', arguments: { player: 'colin' } })).content[0].text.includes('backchecking'), 'mcp search_notes');
assert((await rpc('tools/call', { name: 'faceoff_report', arguments: {} })).content[0].text.includes('Colin Walsh: 1/2'), 'mcp faceoff_report');
await j('DELETE', `/api/events/a5`);
assert((await j('GET', `/api/games/${g.id}`)).events.length === 5, 'delete event');
console.log('\n' + md);
