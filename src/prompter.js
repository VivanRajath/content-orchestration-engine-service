import { createInterface } from 'node:readline';
import { c } from './util.js';

/**
 * The questions the CLI asks, behind one small interface.
 *
 *   ask(question, { default })     free text
 *   choose(question, options)      numbered list, returns the chosen value
 *   confirm(question, default)     y/n
 *   secret(question)               like ask, but not echoed
 *   close()
 *
 * Every interactive flow — onboarding, /prompt, /dev — takes a prompter rather
 * than touching stdin, so a test drives it with scripted answers and never
 * needs a terminal. That is the whole reason this is not just readline inline.
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let muted = false;
  let closed = false;

  // readline has no "don't echo" option. Swallowing writes while a secret is
  // being typed is the standard way to hide it: the characters still arrive,
  // they are just never printed back to the screen.
  const write = rl._writeToOutput?.bind(rl);
  if (write) {
    rl._writeToOutput = (s) => {
      if (!muted) return write(s);
      // Let the newline through so the next prompt starts on its own line.
      if (s === '\r\n' || s === '\n' || s === '\r') write('\n');
    };
  }

  rl.on('close', () => { closed = true; });

  // One close listener per question, removed as soon as that question is
  // answered. Leaving them attached leaked one per prompt, and after eleven
  // Node printed a memory-leak warning into the middle of the conversation —
  // a /prompt interview alone asks more than that.
  const question = (q) => new Promise((resolve) => {
    if (closed) return resolve(null);
    const onClose = () => resolve(null);
    rl.once('close', onClose);
    rl.question(q, (answer) => {
      rl.off('close', onClose);
      resolve(answer);
    });
  });

  return {
    async ask(q, { default: fallback = '' } = {}) {
      const hint = fallback ? c.d(` (${fallback})`) : '';
      const answer = await question(`  ${q}${hint} `);
      if (answer === null) return null;
      return answer.trim() || fallback;
    },

    async choose(q, options, { default: fallback = 0 } = {}) {
      console.log(`  ${q}`);
      options.forEach((o, i) => {
        const label = typeof o === 'string' ? o : o.label;
        const note = typeof o === 'object' && o.note ? c.d(`  ${o.note}`) : '';
        console.log(`   ${c.c(String(i + 1).padStart(2))}  ${label}${note}`);
      });
      for (;;) {
        const raw = await question(`  ${c.d(`pick 1-${options.length}`)} ${c.d(`(${fallback + 1})`)} `);
        if (raw === null) return null;
        const n = raw.trim() === '' ? fallback + 1 : Number(raw.trim());
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
          const o = options[n - 1];
          return typeof o === 'object' && 'value' in o ? o.value : o;
        }
        console.log(`  ${c.y('!')} enter a number from 1 to ${options.length}`);
      }
    },

    async confirm(q, fallback = true) {
      const answer = await question(`  ${q} ${c.d(fallback ? '[Y/n]' : '[y/N]')} `);
      if (answer === null) return fallback;
      const a = answer.trim().toLowerCase();
      if (!a) return fallback;
      return a === 'y' || a === 'yes';
    },

    async secret(q) {
      process.stdout.write(`  ${q} `);
      muted = true;
      try {
        const answer = await question('');
        return answer === null ? null : answer.trim();
      } finally {
        muted = false;
      }
    },

    close() {
      if (!closed) rl.close();
    },
  };
}

/**
 * A prompter that answers from a list, for tests.
 *
 * Throws when the script runs out rather than returning empty strings, so a
 * flow that asks one question more than the test expected fails loudly instead
 * of silently taking a default and passing for the wrong reason.
 */
export function scriptedPrompter(answers) {
  const queue = [...answers];
  const asked = [];
  const next = (q) => {
    asked.push(q);
    if (!queue.length) throw new Error(`scripted prompter ran out of answers at: ${q}`);
    return queue.shift();
  };
  return {
    asked,
    async ask(q, { default: fallback = '' } = {}) {
      const a = next(q);
      return a === '' ? fallback : a;
    },
    async choose(q, options, { default: fallback = 0 } = {}) {
      const a = next(q);
      const i = a === '' ? fallback : Number(a) - 1;
      const o = options[i];
      if (o === undefined) throw new Error(`scripted choice ${a} is out of range for: ${q}`);
      return typeof o === 'object' && 'value' in o ? o.value : o;
    },
    async confirm(q, fallback = true) {
      const a = String(next(q)).toLowerCase();
      if (a === '') return fallback;
      return a === 'y' || a === 'yes';
    },
    async secret(q) {
      return next(q);
    },
    close() {},
    remaining: () => queue.length,
  };
}
