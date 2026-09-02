const on = process.stdout.isTTY && !process.env.NO_COLOR;
const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { b: w('1'), d: w('2'), g: w('32'), y: w('33'), r: w('31'), c: w('36') };

export function ok(msg)   { console.log(c.g('✓ ') + msg); }
export function info(msg) { console.log(c.d('  ' + msg)); }
export function warn(msg) { console.log(c.y('! ') + msg); }
