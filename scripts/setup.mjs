#!/usr/bin/env node
// Interactive first-run setup. Fills soul.md placeholders and writes .env.
//   npm run setup
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { QUESTIONS, applyAnswers, isConfigured } from '../src/owner-setup.js';

if (await isConfigured()) {
  console.log('Already configured. Edit .env or soul.md directly to change details.');
  process.exit(0);
}

const rl = readline.createInterface({ input, output });
console.log('\n=== First-run setup ===\n');
const answers = {};
for (const { key, q, def } of QUESTIONS) {
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ''} `)).trim();
  answers[key] = a && a !== '-' ? a : (def || '');
}
await rl.close();
const applied = await applyAnswers(answers);
console.log(`\nDone. I'm set up as "${applied.ASSISTANT_NAME}" working for "${applied.OWNER_NAME}".`);
console.log('soul.md placeholders filled and .env written. Start the bot with: npm start\n');
