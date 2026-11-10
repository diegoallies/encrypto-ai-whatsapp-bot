// Thin wrapper around Baileys' native poll message. WhatsApp limits a poll
// to 12 options; selectableCount defaults to 1 (single-choice).

const MAX_OPTIONS = 12;

export async function sendPoll(sock, jid, name, values, { selectableCount = 1 } = {}) {
  if (!name) throw new Error('poll name required');
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error('poll needs at least 2 options');
  }
  const opts = values.slice(0, MAX_OPTIONS).map(String);
  return sock.sendMessage(jid, {
    poll: {
      name: String(name),
      values: opts,
      selectableCount: Math.max(1, Math.min(opts.length, selectableCount)),
    },
  });
}

// Convenience: yes/no confirmation poll.
export async function sendConfirmPoll(sock, jid, question) {
  return sendPoll(sock, jid, question, ['Yes', 'No']);
}
