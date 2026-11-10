// First-run owner onboarding.
//
// The shipped soul.md / .env use placeholders ({{OWNER_NAME}}, …). The very
// first time the bot runs it collects a few details from the user and fills
// them in, so each install personalises itself without carrying anyone else's
// identity in the repo.
//
// Two entry points:
//   • scripts/setup.mjs  — interactive CLI (`npm run setup`)
//   • onboarding over WhatsApp — the first DM triggers a short Q&A, handled by
//     feedOwnerOnboarding() which the message handler calls while unconfigured.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOUL = path.join(ROOT, 'soul.md');
const ENV = path.join(ROOT, '.env');
const STATE = path.join(ROOT, 'memory', 'owner-setup-state.json');

export const QUESTIONS = [
  { key: 'ASSISTANT_NAME', q: "What should I call myself (the assistant's name)?", def: 'Encrypto AI' },
  { key: 'OWNER_NAME',     q: 'What is your name (how I should address you)?', def: '' },
  { key: 'OWNER_FIRST_NAME', q: 'And your first name / nickname for casual chats?', def: '' },
  { key: 'OWNER_PHONE',    q: 'Your phone number in international format (e.g. +27821234567)?', def: '' },
  { key: 'OWNER_CITY',     q: 'Which city are you in? (optional, reply "-" to skip)', def: '' },
  { key: 'OWNER_TIMEZONE', q: 'Your timezone? (e.g. Africa/Johannesburg, reply "-" to skip)', def: '' },
];

export async function isConfigured() {
  try {
    const soul = await fs.readFile(SOUL, 'utf8');
    if (/\{\{OWNER_NAME\}\}/.test(soul)) return false;
  } catch {}
  return Boolean(process.env.OWNER_NAME);
}

function jidFromPhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

// Apply the collected answers: fill soul.md placeholders and write .env keys.
export async function applyAnswers(answers) {
  const a = { ...answers };
  if (!a.ASSISTANT_NAME) a.ASSISTANT_NAME = 'Encrypto AI';
  if (!a.OWNER_FIRST_NAME) a.OWNER_FIRST_NAME = (a.OWNER_NAME || '').split(/\s+/)[0] || a.OWNER_NAME || 'boss';

  // 1. soul.md placeholders
  let soul = await fs.readFile(SOUL, 'utf8');
  for (const [k, v] of Object.entries(a)) {
    soul = soul.split(`{{${k}}}`).join(v || '');
  }
  // strip the first-run banner once filled
  soul = soul.replace(/^> FIRST-RUN SETUP:[\s\S]*?\n\n/m, '');
  await fs.writeFile(SOUL, soul);

  // 2. .env keys (append or update)
  let env = '';
  try { env = await fs.readFile(ENV, 'utf8'); } catch {}
  const set = (key, val) => {
    if (!val) return;
    const line = `${key}=${val}`;
    env = new RegExp(`^${key}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : (env.trimEnd() + `\n${line}\n`);
  };
  set('ASSISTANT_NAME', a.ASSISTANT_NAME);
  set('OWNER_NAME', a.OWNER_NAME);
  set('OWNER_FIRST_NAME', a.OWNER_FIRST_NAME);
  set('OWNER_PHONE', a.OWNER_PHONE);
  const jid = jidFromPhone(a.OWNER_PHONE);
  set('OWNER_JID', jid);
  set('OWNER_PHONE_JID', jid);
  if (!/^OWNER_JIDS=/m.test(env) && jid) set('OWNER_JIDS', jid);
  if (a.OWNER_CITY && a.OWNER_CITY !== '-') set('OWNER_CITY', a.OWNER_CITY);
  if (a.OWNER_TIMEZONE && a.OWNER_TIMEZONE !== '-') set('OWNER_TIMEZONE', a.OWNER_TIMEZONE);
  await fs.writeFile(ENV, env);

  // reflect into the live process so this session is configured too
  process.env.ASSISTANT_NAME = a.ASSISTANT_NAME;
  process.env.OWNER_NAME = a.OWNER_NAME;
  process.env.OWNER_FIRST_NAME = a.OWNER_FIRST_NAME;
  process.env.OWNER_PHONE = a.OWNER_PHONE;
  if (jid) { process.env.OWNER_JID = jid; process.env.OWNER_PHONE_JID = jid; if (!process.env.OWNER_JIDS) process.env.OWNER_JIDS = jid; }
  return a;
}

// ---- WhatsApp conversational onboarding (state machine) ----
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE, 'utf8')); }
  catch { return { step: 0, answers: {}, ownerJid: null }; }
}
async function saveState(s) {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(s, null, 2));
}

// Call this for every inbound DM while unconfigured. Returns a string to send
// back (the next question or the done message), or null to let normal handling
// proceed (once configured). The FIRST person to DM becomes the owner.
export async function feedOwnerOnboarding(senderJid, text) {
  if (await isConfigured()) return null;
  const s = await loadState();
  if (!s.ownerJid) s.ownerJid = senderJid;           // claim owner
  if (senderJid !== s.ownerJid) return null;          // ignore others during setup

  if (s.step === 0 && !/\S/.test(text || '')) {
    s.step = 1; await saveState(s);
    return `👋 First-time setup. I'll ask a few quick questions so I know who I work for.\n\n${QUESTIONS[0].q}${QUESTIONS[0].def ? ` (default: ${QUESTIONS[0].def})` : ''}`;
  }

  // record the answer to the previous question
  if (s.step >= 1) {
    const prev = QUESTIONS[s.step - 1];
    const ans = (text || '').trim();
    s.answers[prev.key] = ans && ans !== '-' ? ans : (prev.def || '');
  }

  if (s.step >= QUESTIONS.length) {
    await applyAnswers(s.answers);
    const name = s.answers.ASSISTANT_NAME || 'Encrypto AI';
    await saveState({ step: 999, answers: {}, ownerJid: s.ownerJid });
    return `Done ✅ I'm set up as *${name}*, working for *${s.answers.OWNER_NAME}*. Talk to me normally now.`;
  }

  const next = QUESTIONS[s.step];
  s.step += 1; await saveState(s);
  return `${next.q}${next.def ? ` (default: ${next.def})` : ''}`;
}
