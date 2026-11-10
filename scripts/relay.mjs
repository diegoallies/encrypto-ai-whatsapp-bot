#!/usr/bin/env node
// CLI for managing pending relays
// Usage:
//   node scripts/relay.mjs add --from "Devandry" --summary "wants data"
//   node scripts/relay.mjs list
//   node scripts/relay.mjs clear <id>
//   node scripts/relay.mjs clear-all

import { addRelay, getRelays, clearRelay, clearAllRelays } from '../src/pending-relays.js';

const [,, cmd, ...args] = process.argv;

async function main() {
  switch (cmd) {
    case 'add': {
      const fromIdx = args.indexOf('--from');
      const summaryIdx = args.indexOf('--summary');
      if (fromIdx === -1 || summaryIdx === -1) {
        console.error('Usage: relay.mjs add --from <name> --summary <text>');
        process.exit(1);
      }
      const from = args[fromIdx + 1];
      const summary = args[summaryIdx + 1];
      const id = await addRelay({ from, summary });
      console.log(`Added relay: ${id}`);
      break;
    }
    case 'list': {
      const relays = await getRelays();
      if (relays.length === 0) {
        console.log('No pending relays');
      } else {
        for (const r of relays) {
          console.log(`${r.id}: from=${r.from} summary="${r.summary}" reminded=${r.reminded}`);
        }
      }
      break;
    }
    case 'clear': {
      const id = args[0];
      if (!id) {
        console.error('Usage: relay.mjs clear <id>');
        process.exit(1);
      }
      await clearRelay(id);
      console.log(`Cleared relay: ${id}`);
      break;
    }
    case 'clear-all': {
      await clearAllRelays();
      console.log('Cleared all relays');
      break;
    }
    default:
      console.log('Commands: add, list, clear, clear-all');
  }
}

main().catch(console.error);
