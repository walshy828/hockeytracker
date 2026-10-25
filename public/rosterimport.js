// Parses a copy/paste of a TeamSnap roster ("Name / Contact Info / # / Position").
// Returns [{name, number, position}] only — contact lines (emails, phones, parents) are discarded.
const POS = {
  defense: 'D', defence: 'D', d: 'D', forward: 'F', f: 'F', goalie: 'G', goalkeeper: 'G', g: 'G',
  center: 'C', centre: 'C', c: 'C', 'left wing': 'F', 'right wing': 'F', wing: 'F', winger: 'F', lw: 'F', rw: 'F',
};
const NOISE = /^(name|contact info|# ?\/ ?position|team owner|team manager|coach|manager|assistant coach)$/i;

function jerseyLine(line) {
  const m = line.match(/^(?:#\s*(\d+))?\s*(?:-\s*)?(.*)$/);
  const rest = m[2].trim().toLowerCase();
  if (m[1] === undefined && !(rest in POS)) return null;
  if (rest && !(rest in POS)) return null;
  return { number: m[1] || '', position: POS[rest] || '' };
}
const looksLikeName = (l) => /^[A-Za-z][A-Za-z'’.\- ]*$/.test(l) && !(l.toLowerCase() in POS) && !NOISE.test(l);

export function parseRoster(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^(name|contact info|# ?\/ ?position)$/i.test(l));
  const out = []; let cur = null; let prevEnded = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const next = lines[i + 1] || '';
    const j = jerseyLine(l);
    if (j) { if (cur) { cur.number = j.number; cur.position = j.position; } prevEnded = true; cur = cur && (out.push(cur), null); continue; }
    if (!looksLikeName(l)) continue;
    const firstNameThenFull = !l.includes(' ') && next.toLowerCase().startsWith(l.toLowerCase() + ' ');
    if (firstNameThenFull || (prevEnded && !cur)) {
      if (cur) out.push(cur);
      cur = { name: firstNameThenFull ? next : l, number: '', position: '' };
      if (firstNameThenFull) i++;
      prevEnded = false;
    }
  }
  if (cur) out.push(cur);
  return out;
}
