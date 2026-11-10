// Split a long reply into WhatsApp-friendly chunks. Prefers paragraph
// boundaries, falls back to newline, then space. If a cut leaves a code
// fence (```) unclosed, the head is closed and the tail re-opens it so
// neither chunk renders as broken markdown.

const MAX = 3500;
const MIN_RATIO = 0.5;

function isInsideCodeFence(text) {
  const matches = text.match(/```/g);
  return matches ? matches.length % 2 === 1 : false;
}

function pickCut(text) {
  let idx = text.lastIndexOf('\n\n', MAX);
  if (idx > MAX * MIN_RATIO) return idx + 2;
  idx = text.lastIndexOf('\n', MAX);
  if (idx > MAX * MIN_RATIO) return idx + 1;
  idx = text.lastIndexOf(' ', MAX);
  if (idx > MAX * MIN_RATIO) return idx + 1;
  return MAX;
}

export function splitForWhatsApp(text) {
  if (!text) return [];
  if (text.length <= MAX) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > MAX) {
    const cut = pickCut(remaining);
    let head = remaining.slice(0, cut).trimEnd();
    let tail = remaining.slice(cut);

    if (isInsideCodeFence(head)) {
      head += '\n```';
      tail = '```\n' + tail;
    }

    parts.push(head);
    remaining = tail;
  }
  if (remaining.length > 0) parts.push(remaining.trimEnd());
  return parts;
}
