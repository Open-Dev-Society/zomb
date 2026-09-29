#!/usr/bin/env node
// `zomb guard` runs on every agent edit, so it skips the full scanner's imports (Knip, oxc, jscpd) and starts in milliseconds.
if (process.argv[2] === 'guard') await (await import('./guard.js')).main();
else await import('./cli.js');
