// Slash-command registry. Each spec:
//   {
//     name: 'reset',                       // /reset
//     match: (trimmed) => bool,            // optional override; defaults to startsWith('/<name>')
//     auth: 'owner' | 'allowlist',         // who may run it (owner = first ALLOWED_JIDS entry)
//     handler: async ({ sock, jid, args, ctx }) => void,
//   }
//
// `args` is the text after the command name (already trimmed).
// `ctx` carries shared deps the handler injects (agent, scheduler, isOwner, ...).

const commands = [];

export function registerCommand(spec) {
  if (!spec?.name || typeof spec.handler !== 'function') {
    throw new Error('registerCommand: { name, handler } required');
  }
  // Default is owner-only — the bot's tool surface is dangerous (Bash, Write,
  // Edit). Commands that should be open to any allowlisted user opt in with
  // `auth: 'allowlist'`.
  const auth = spec.auth || 'owner';
  const match = spec.match || ((t) => {
    const head = `/${spec.name}`;
    return t === head || t.startsWith(head + ' ');
  });
  commands.push({ ...spec, auth, match });
}

export function listCommands() {
  return commands.map((c) => ({ name: c.name, auth: c.auth }));
}

export function clearCommands() {
  commands.length = 0;
}

export function findCommand(trimmed) {
  return commands.find((c) => c.match(trimmed)) || null;
}

// Returns { handled: bool, reason?: 'unauthorized' | 'no-match' }
export async function dispatchCommand(trimmed, deps) {
  const cmd = findCommand(trimmed);
  if (!cmd) return { handled: false, reason: 'no-match' };

  const { jid, sock, isOwner } = deps;
  if (cmd.auth === 'owner' && !isOwner(jid)) {
    await sock.sendMessage(jid, { text: `⛔ /${cmd.name} is owner-only.` }).catch(() => {});
    return { handled: true, reason: 'unauthorized' };
  }

  const head = `/${cmd.name}`;
  const args = trimmed.startsWith(head) ? trimmed.slice(head.length).trim() : '';
  await cmd.handler({ ...deps, args });
  return { handled: true };
}
