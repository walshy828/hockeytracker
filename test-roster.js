// Fixture uses fake contact data but mirrors TeamSnap's quirks (no first-name line, missing position, "Team Owner", repeated parents).
import { parseRoster } from './public/rosterimport.js';
const t = `Name
Contact Info
# / Position
Aaron
Aaron Mitchell
Pat Mitchell
pat@example.com
(555) 010-0001
#37 - Defense
Brandon
Brandon Bishop
Sam Bishop
sam@example.com - Dad
Brandon Bishop
bb@example.com
5550100002
Goalie
Chase
Chase Rancourt
Team Owner

Lee Rancourt
lee@example.com - Dad
#8 - Forward
Colin
Colin Walsh
Kim Walsh
kim@example.com
#45 - D
David
David Newbould
Dave Newbould
dave@example.com - Dad
David Newbould Jr
dnj@example.com
5550100003
Harrison
Harrison Mullen
Jo Mullen
jo@example.com - Mom
#6
Mason
Mason McElroy
Jay McElroy
jay@example.com
#16 - left wing
Nate Lucey
Sean Lucey
sean@example.com
Andrea Lucey
andrea@example.com - Mom
5550100004 - Mom
#19 - Defense
Ryan
Ryan McManus
Tim McManus
tim@example.com
Defense`;
const got = parseRoster(t).map((p) => `${p.name}|${p.number}|${p.position}`);
const want = ['Aaron Mitchell|37|D', 'Brandon Bishop||G', 'Chase Rancourt|8|F', 'Colin Walsh|45|D', 'David Newbould||', 'Harrison Mullen|6|', 'Mason McElroy|16|F', 'Nate Lucey|19|D', 'Ryan McManus||D'];
if (JSON.stringify(got) !== JSON.stringify(want)) { console.error('FAIL\n', got.join('\n')); process.exit(1); }
console.log('ok roster parse', got.length);
