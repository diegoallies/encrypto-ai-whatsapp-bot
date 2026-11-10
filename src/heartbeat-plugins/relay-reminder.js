// Heartbeat plugin: Relay Reminder
// Checks for pending relays that haven't been sent to the owner and reminds

import { getRelays, markReminded } from '../pending-relays.js';

const FIVE_MINUTES = 5 * 60 * 1000;

export default {
  name: 'relay-reminder',
  intervalMs: FIVE_MINUTES,
  async run({ send }) {
    const relays = await getRelays();
    if (relays.length === 0) return;

    // Find relays older than 5 minutes that haven't been reminded
    const now = Date.now();
    const overdue = relays.filter(r => {
      const age = now - new Date(r.promisedAt).getTime();
      return age > FIVE_MINUTES && !r.reminded;
    });

    if (overdue.length === 0) return;

    // Build reminder message
    const lines = ['I have pending relays I promised to send you:'];
    for (const r of overdue) {
      lines.push(`- From ${r.from}: ${r.summary}`);
      await markReminded(r.id);
    }

    return lines.join('\n');
  }
};
