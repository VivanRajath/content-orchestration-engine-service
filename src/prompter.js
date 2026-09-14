import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { c } from './util.js';

/**
 * The questions the CLI asks, behind one small interface.
 *
 *   ask(question, { default })     free text
 *   choose(question, options)      numbered list, returns the chosen value
 *   confirm(question, default)     y/n
 *   secret(question)               typed or pasted, echoed as ***
 *   close()
 *
 * Every interactive flow — onboarding, /prompt, /dev, and checkpoints during a
 * run — goes through ONE prompter holding ONE readline interface. A second
 * interface on the same stdin is what made the chat stop accepting input: when
 * the other one closed, it paused stdin and turned raw mode off underneath this
 * one.
 *
 * Tests drive a real terminal-mode interface through a fake TTY
 * (test/terminal.test.js). The earlier suite only ever ran readline in
 * non-terminal mode, which is a different code path from a real terminal's, and
 * every bug in this file lived in the part it never touched.
 */
export function createPrompter({
  input = process.stdin,
  output = process.stdout,
  readClipboard = clipboard,
  platform = process.platform,
} = {}) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output, terminal });
  let closed = false;

  // --- masked echo ---------------------------------------------------------
  //
  // A secret used to be read with echo swallowed entirely, and its label was
  // written separately with process.stdout.write. In a terminal, readline
  // redraws the line when it starts reading, which wiped the label; with echo
  // off, nothing typed or pasted appeared either. The result was a blank line
  // that looked like it was ignoring the user.
  //
  // Now the label is readline's own prompt, so a redraw keeps it, and each
  // character is echoed as `*` — visible proof a paste landed, without showing
  // the key.
  let masking = false;
  let maskPrompt = '';

  // Every readline write to the screen goes through `_writeToOutput`. Node 24
  // also has a symbol-keyed accessor, but its getter just returns
  // `this._writeToOutput` — so shadowing that one method on the instance
  // intercepts everything. (Assigning the symbol instead throws: it is a
  // getter-only accessor on the prototype.) Capture the original first so the
  // replacement calls through to the real writer rather than into itself.
  const writer = rl._writeToOutput;
  if (terminal && typeof writer === 'function') {
    const original = writer.bind(rl);
    rl._writeToOutput = (s) => {
      if (!masking) return original(s);
      if (s === '\r\n' || s === '\n' || s === '\r') return original(s);
      // A full redraw writes the prompt followed by the whole line.
      if (maskPrompt && s.startsWith(maskPrompt)) return original(maskPrompt + '*'.repeat(rl.line.length));
      // A keystroke or a pasted run writes just the new characters.
      return original('*'.repeat([...s].length));
    };
  }

  // --- Ctrl+V on Windows ----------------------------------------------------
  //
  // In a raw-mode Windows console, Ctrl+V does not paste: the console passes a
  // literal ^V keypress to the program, and readline ignores it. Pasting an API
  // key with Ctrl+V silently did nothing. When ^V arrives, read the clipboard
  // and insert it as if typed. Terminals that paste Ctrl+V themselves (Windows
  // Terminal, macOS, Linux) never send ^V, so this only fires where it's needed.
  if (terminal && platform === 'win32') {
    input.on('keypress', (_s, key) => {
      if (closed || !key?.ctrl || key.name !== 'v') return;
      const text = readClipboard();
      // One line only: a trailing newline in the clipboard would submit the
      // answer before the user had a chance to look at it.
      if (text) rl.write(text.replace(/[\r\n]+/g, ' ').trim());
    });
  }

  rl.on('close', () => { closed = true; });

  // One close listener per question, removed once it is answered. Leaving them
  // attached leaked one per prompt, and after eleven Node printed a memory-leak
  // warning into the middle of the conversation.
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
    terminal,

    async ask(q, { default: fallback = '' } = {}) {
      const hint = fallback ? c.d(` (${fallback})`) : '';
      const answer = await question(`  ${q}${hint} `);
      if (answer === null) return null;
      return answer.trim() || fallback;
    },

    async choose(q, options, { default: fallback = 0 } = {}) {
      if (q) console.log(`  ${q}`);
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
      // The prompt must be plain text: masking recognises a redraw by the
      // prompt it starts with, and colour codes would make that comparison
      // depend on how readline re-emits them.
      maskPrompt = `  ${q} `;
      masking = true;
      try {
        const answer = await question(maskPrompt);
        return answer === null ? null : answer.trim();
      } finally {
        masking = false;
        maskPrompt = '';
      }
    },

    close() {
      if (!closed) rl.close();
    },
  };
}

/**
 * The Windows clipboard, read only in direct response to the user pressing
 * Ctrl+V. PowerShell ships with every supported Windows, so this needs no
 * dependency; any failure just means nothing is pasted.
 */
function clipboard() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
  } catch {
    return '';
  }
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
    terminal: false,
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
