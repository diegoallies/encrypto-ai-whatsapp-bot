// Shared rendering helpers used by every webui route module:
//   - esc(s)          HTML-escape user-supplied strings
//   - formatPhoneForDisplay(digits)  "27671234567" → "+27 67 123 4567"
//   - NAV / MOBILE_NAV  sidebar + bottom-nav entries
//   - LAYOUT(title, body, currentPath)  full page chrome
//
// Anything route modules need to share goes here. Keep this file pure: no
// route handlers, no req/res, no side effects on import.
import { isPoweredOn } from '../bot-power.js';

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatPhoneForDisplay(digits) {
  if (!digits) return '';
  const d = String(digits).replace(/\D+/g, '');
  if (d.length >= 11) {
    const cc = d.slice(0, 2);
    return `+${cc} ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  }
  return `+${d}`;
}

// NAV entries: [href, label, lucide-icon]
export const NAV = [
  ['/', 'Dashboard', 'layout-dashboard'],
  ['/people', 'People', 'users'],
  ['/search', 'Search', 'search'],
  ['/analytics', 'Analytics', 'bar-chart-3'],
  ['/queue', 'Queue', 'list-ordered'],
  ['/upload', 'Upload', 'upload-cloud'],
  ['/jobs', 'Jobs', 'calendar-clock'],
  ['/playbooks', 'Playbooks', 'book-open-check'],
  ['/memory', 'Memory', 'database'],
  ['/persona', 'Persona', 'sparkles'],
  ['/proofreader', 'Proofreader', 'scan-text'],
  ['/settings', 'Settings', 'settings-2'],
];

// Bottom-nav: 4 most-used links + a "More" button that opens a drawer with
// the remaining destinations (so nothing is unreachable on mobile).
export const MOBILE_NAV = [
  ['/', 'Home', 'layout-dashboard'],
  ['/people', 'People', 'users'],
  ['/search', 'Search', 'search'],
  ['/playbooks', 'Run', 'book-open-check'],
];

export const LAYOUT = (title, body, currentPath = '/') => {
  const streamOn = process.env.STREAM_REPLIES !== '0';
  const poweredOn = isPoweredOn();
  const sidebarItem = (href, label, icon) => {
    const active = currentPath === href;
    return `<a href="${href}" class="group flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${active ? 'bg-emerald-500/10 text-emerald-300 shadow-inner shadow-emerald-500/5' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}">
      <i data-lucide="${icon}" class="size-[18px] ${active ? 'text-emerald-400' : 'text-zinc-500 group-hover:text-zinc-300'}"></i>
      <span class="text-sm font-medium">${esc(label)}</span>
    </a>`;
  };
  const mobileItem = (href, label, icon) => {
    const active = currentPath === href;
    return `<a href="${href}" class="flex flex-col items-center justify-center gap-0.5 py-2.5 ${active ? 'text-emerald-400' : 'text-zinc-500'}">
      <i data-lucide="${icon}" class="size-5"></i>
      <span class="text-[10px] font-medium">${esc(label)}</span>
    </a>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Encrypto">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<title>${esc(title)} · Encrypto AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://unpkg.com/htmx.org@1.9.12"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: {
          sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
          mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        },
      },
    },
  };
</script>
<style>
  :root {
    --bg-main: #09090b; --bg-card: rgb(24 24 27 / 0.6); --bg-input: rgb(24 24 27 / 0.8);
    --border-main: rgb(39 39 42 / 0.8); --border-subtle: rgb(63 63 70);
    --text-main: #f4f4f5; --text-muted: #a1a1aa; --text-dim: #71717a;
  }
  [data-theme="light"] {
    --bg-main: #fafafa; --bg-card: rgb(255 255 255 / 0.8); --bg-input: rgb(255 255 255 / 0.9);
    --border-main: rgb(228 228 231); --border-subtle: rgb(212 212 216);
    --text-main: #18181b; --text-muted: #52525b; --text-dim: #71717a;
  }
  html, body { font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
  pre, code, textarea.mono, .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
  input, select, textarea, button { font-size: 16px; }
  .log-line { white-space: pre-wrap; word-break: break-word; }
  .log-warn { color: #fbbf24; }
  .log-error { color: #f87171; }
  [data-theme="light"] .log-warn { color: #b45309; }
  [data-theme="light"] .log-error { color: #dc2626; }
  [x-cloak] { display: none !important; }
  /* Ambient gradient backdrop */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(ellipse 50% 35% at 15% 5%, rgba(16,185,129,0.08), transparent 60%),
      radial-gradient(ellipse 45% 30% at 85% 25%, rgba(99,102,241,0.05), transparent 60%);
  }
  [data-theme="light"] body::before {
    background:
      radial-gradient(ellipse 50% 35% at 15% 5%, rgba(16,185,129,0.12), transparent 60%),
      radial-gradient(ellipse 45% 30% at 85% 25%, rgba(99,102,241,0.08), transparent 60%);
  }
  main, header, nav, aside { position: relative; z-index: 1; }
  .card { background-color: rgb(24 24 27 / 0.6); backdrop-filter: blur(12px); border: 1px solid rgb(39 39 42 / 0.8); border-radius: 0.875rem; box-shadow: 0 8px 32px -8px rgb(0 0 0 / 0.5); }
  [data-theme="light"] .card { background-color: rgb(255 255 255 / 0.8); border-color: rgb(228 228 231); box-shadow: 0 4px 16px -4px rgb(0 0 0 / 0.1); }
  .stat { background: linear-gradient(180deg, rgb(24 24 27 / 0.6), rgb(24 24 27 / 0.3)); backdrop-filter: blur(8px); border: 1px solid rgb(39 39 42 / 0.8); border-radius: 0.875rem; padding: 1rem; position: relative; overflow: hidden; }
  [data-theme="light"] .stat { background: linear-gradient(180deg, rgb(255 255 255 / 0.9), rgb(250 250 250 / 0.7)); border-color: rgb(228 228 231); }
  .stat::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 100% 0%, rgba(255,255,255,0.04), transparent 50%); pointer-events: none; }
  .btn { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.5rem 0.875rem; border-radius: 0.5rem; font-weight: 500; font-size: 0.875rem; transition: all 0.15s ease; line-height: 1; }
  .btn-primary { background: linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105)); color: rgb(9 9 11); box-shadow: 0 4px 12px -4px rgb(16 185 129 / 0.4); }
  .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 6px 16px -4px rgb(16 185 129 / 0.5); }
  .btn-ghost { background-color: rgb(39 39 42 / 0.6); color: rgb(228 228 231); border: 1px solid rgb(63 63 70); }
  .btn-ghost:hover { background-color: rgb(63 63 70 / 0.8); }
  [data-theme="light"] .btn-ghost { background-color: rgb(244 244 245); color: rgb(39 39 42); border-color: rgb(212 212 216); }
  [data-theme="light"] .btn-ghost:hover { background-color: rgb(228 228 231); }
  .btn-danger { background-color: rgb(244 63 94 / 0.1); color: rgb(251 113 133); border: 1px solid rgb(244 63 94 / 0.3); }
  .btn-danger:hover { background-color: rgb(244 63 94 / 0.2); }
  .btn-icon { padding: 0.5rem; }
  .input, select.input, textarea.input { background-color: rgb(24 24 27 / 0.8); border: 1px solid rgb(63 63 70); border-radius: 0.5rem; padding: 0.625rem 0.875rem; color: rgb(244 244 245); width: 100%; outline: none; transition: border-color 0.15s; }
  [data-theme="light"] .input, [data-theme="light"] select.input, [data-theme="light"] textarea.input { background-color: rgb(255 255 255); border-color: rgb(212 212 216); color: rgb(24 24 27); }
  .input:focus { border-color: rgb(16 185 129); box-shadow: 0 0 0 3px rgb(16 185 129 / 0.15); }
  .label { font-size: 0.7rem; font-weight: 600; color: rgb(113 113 122); text-transform: uppercase; letter-spacing: 0.08em; }
  .pulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: rgb(34 197 94); box-shadow: 0 0 0 0 rgb(34 197 94 / 0.7); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgb(34 197 94 / 0.7); } 70% { box-shadow: 0 0 0 8px rgb(34 197 94 / 0); } 100% { box-shadow: 0 0 0 0 rgb(34 197 94 / 0); } }
  .typing-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: rgb(251 191 36); animation: typing-pulse 1s infinite; }
  @keyframes typing-pulse { 0%, 100% { opacity: 0.4; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
  /* Icon helpers */
  .icon-tile { display: inline-flex; align-items: center; justify-content: center; height: 2.25rem; width: 2.25rem; border-radius: 0.625rem; }
  .icon-tile-emerald { background-color: rgb(16 185 129 / 0.12); color: rgb(52 211 153); border: 1px solid rgb(16 185 129 / 0.25); }
  .icon-tile-amber { background-color: rgb(245 158 11 / 0.12); color: rgb(252 211 77); border: 1px solid rgb(245 158 11 / 0.25); }
  .icon-tile-rose { background-color: rgb(244 63 94 / 0.12); color: rgb(251 113 133); border: 1px solid rgb(244 63 94 / 0.25); }
  .icon-tile-violet { background-color: rgb(139 92 246 / 0.12); color: rgb(167 139 250); border: 1px solid rgb(139 92 246 / 0.25); }
  .icon-tile-sky { background-color: rgb(14 165 233 / 0.12); color: rgb(56 189 248); border: 1px solid rgb(14 165 233 / 0.25); }
  .icon-tile-zinc { background-color: rgb(63 63 70 / 0.4); color: rgb(212 212 216); border: 1px solid rgb(82 82 91 / 0.5); }
  .theme-body { background-color: #09090b; color: #f4f4f5; }
  [data-theme="light"] .theme-body { background-color: #fafafa; color: #18181b; }
  [data-theme="light"] aside { background-color: rgb(255 255 255 / 0.7) !important; border-color: rgb(228 228 231) !important; }
  [data-theme="light"] header { background-color: rgb(255 255 255 / 0.85) !important; border-color: rgb(228 228 231) !important; }
  [data-theme="light"] nav.grid { background-color: rgb(255 255 255 / 0.95) !important; border-color: rgb(228 228 231) !important; }
  [data-theme="light"] pre { background-color: rgb(250 250 250 / 0.6) !important; color: #3f3f46 !important; }
  /* Horizontal scrolling tab row for narrow viewports — no wrapping, no visible scrollbar. */
  .tab-row { display: flex; gap: 0.5rem; overflow-x: auto; scrollbar-width: none; margin-bottom: 1rem; }
  .tab-row::-webkit-scrollbar { display: none; }
  .tab-row > * { flex: 0 0 auto; white-space: nowrap; }
  @media (max-width: 767px) {
    /* Bleed tab rows to the screen edges so the scroll affordance is obvious. */
    .tab-row { margin-left: -1rem; margin-right: -1rem; padding-left: 1rem; padding-right: 1rem; }
  }
</style>
<script>
  // Apply saved theme before render to avoid flash
  (function() {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  })();
</script>
</head>
<body class="min-h-screen theme-body">
<div class="md:flex">
  <!-- Sidebar (desktop) -->
  <aside class="hidden md:flex md:flex-col fixed inset-y-0 left-0 w-60 border-r border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-3 py-5 z-20">
    <a href="/" class="flex items-center gap-2.5 px-2 mb-6">
      <span class="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-zinc-950 font-bold text-sm shadow-lg shadow-emerald-500/30">E</span>
      <span class="font-semibold tracking-tight">Encrypto&nbsp;AI</span>
    </a>
    <nav class="flex flex-col gap-0.5">
      ${NAV.map(([href, label, icon]) => sidebarItem(href, label, icon)).join('')}
    </nav>
    <div class="mt-auto pt-4 border-t border-zinc-900 space-y-2">
      <div id="bot-status" class="flex items-center gap-2 px-2 text-xs text-zinc-500">
        <span class="pulse-dot" style="${poweredOn ? '' : 'background:#71717a;animation:none;box-shadow:none'}"></span>
        <span id="status-text">${poweredOn ? 'Bot is live' : 'Bot is offline'}</span>
      </div>
      <div id="typing-indicator" class="hidden px-2 py-1.5 bg-amber-500/10 rounded-lg border border-amber-500/20">
        <div class="flex items-center gap-2 text-xs text-amber-300">
          <span class="typing-dot"></span>
          <span id="typing-text">Processing...</span>
        </div>
      </div>
      <button id="theme-toggle" class="w-full btn btn-ghost" onclick="toggleTheme()" title="Toggle light/dark mode">
        <i data-lucide="sun" class="size-4 theme-icon-sun"></i>
        <i data-lucide="moon" class="size-4 theme-icon-moon hidden"></i>
        <span class="theme-label">Light mode</span>
      </button>
      <form method="POST" action="/settings/toggle-streaming">
        <button class="w-full btn ${streamOn ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'btn-ghost'}" title="Toggle streaming replies">
          <i data-lucide="zap" class="size-4"></i>${streamOn ? 'Streaming on' : 'Streaming off'}
        </button>
      </form>
      <button onclick="doRestart()" class="w-full btn btn-danger">
        <i data-lucide="rotate-cw" class="size-4"></i>Restart
      </button>
      <button onclick="setBotPower(${poweredOn ? 'false' : 'true'})" class="w-full btn ${poweredOn ? 'btn-danger' : 'btn-primary'}">
        <i data-lucide="power" class="size-4"></i>${poweredOn ? 'Power Off' : 'Power On'}
      </button>
    </div>
  </aside>

  <!-- Mobile top bar -->
  <header class="md:hidden sticky top-0 z-30 bg-zinc-950/85 backdrop-blur-md border-b border-zinc-900">
    <div class="px-4 py-3 flex items-center gap-3">
      <a href="/" class="flex items-center gap-2 font-semibold">
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-zinc-950 text-sm shadow-lg shadow-emerald-500/20">E</span>
        <span class="tracking-tight">Encrypto</span>
      </a>
      <div id="mobile-status" class="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
        <span class="pulse-dot" style="${poweredOn ? '' : 'background:#71717a;animation:none;box-shadow:none'}"></span><span>${poweredOn ? 'live' : 'offline'}</span>
      </div>
      <div id="mobile-typing" class="hidden ml-auto flex items-center gap-1.5 text-xs text-amber-300">
        <span class="typing-dot"></span><span>typing</span>
      </div>
      <button onclick="doRestart()" class="btn btn-icon btn-danger" aria-label="Restart"><i data-lucide="rotate-cw" class="size-4"></i></button>
      <button onclick="setBotPower(${poweredOn ? 'false' : 'true'})" class="btn btn-icon ${poweredOn ? 'btn-danger' : 'btn-primary'}" aria-label="${poweredOn ? 'Power off' : 'Power on'}"><i data-lucide="power" class="size-4"></i></button>
    </div>
  </header>

  <main class="md:ml-60 flex-1 p-4 md:p-8 pb-24 md:pb-8 max-w-6xl">
${body}
  </main>
</div>

<!-- Mobile bottom nav -->
<nav class="md:hidden fixed bottom-0 inset-x-0 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-900 grid grid-cols-5 z-30">
  ${MOBILE_NAV.map(([href, label, icon]) => mobileItem(href, label, icon)).join('')}
  <button type="button" onclick="document.getElementById('mobileMore').classList.remove('hidden')" class="flex flex-col items-center justify-center gap-0.5 py-2.5 text-zinc-500" aria-label="More">
    <i data-lucide="menu" class="size-5"></i>
    <span class="text-[10px] font-medium">More</span>
  </button>
</nav>

<!-- Mobile "More" drawer: lists everything not in the bottom 4 -->
<div id="mobileMore" class="hidden md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="absolute bottom-0 inset-x-0 bg-zinc-950 border-t border-zinc-800 rounded-t-2xl p-4 pb-8 max-h-[80vh] overflow-y-auto">
    <div class="w-12 h-1 bg-zinc-700 rounded-full mx-auto mb-4"></div>
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold">Navigate</h3>
      <button onclick="document.getElementById('mobileMore').classList.add('hidden')" class="btn btn-icon btn-ghost" aria-label="Close"><i data-lucide="x" class="size-4"></i></button>
    </div>
    <div class="grid grid-cols-2 gap-2">
      ${NAV.filter(([href]) => !MOBILE_NAV.some(([h]) => h === href)).map(([href, label, icon]) => `
        <a href="${href}" class="flex items-center gap-3 p-3 rounded-lg bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800">
          <i data-lucide="${icon}" class="size-5 text-emerald-400"></i>
          <span class="text-sm font-medium">${esc(label)}</span>
        </a>`).join('')}
    </div>
    <div class="mt-4 pt-4 border-t border-zinc-800 flex gap-2">
      <button onclick="toggleTheme()" class="flex-1 btn btn-ghost"><i data-lucide="sun" class="size-4 theme-icon-sun"></i><i data-lucide="moon" class="size-4 theme-icon-moon hidden"></i><span class="theme-label">Light mode</span></button>
      <button onclick="doRestart()" class="flex-1 btn btn-danger"><i data-lucide="rotate-cw" class="size-4"></i>Restart</button>
      <button onclick="setBotPower(${poweredOn ? 'false' : 'true'})" class="flex-1 btn ${poweredOn ? 'btn-danger' : 'btn-primary'}"><i data-lucide="power" class="size-4"></i>${poweredOn ? 'Power Off' : 'Power On'}</button>
    </div>
  </div>
</div>

<!-- Toast notification -->
<div id="toast" class="fixed top-4 right-4 z-50 hidden">
  <div class="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 shadow-lg flex items-center gap-3">
    <i data-lucide="loader" class="size-4 animate-spin text-emerald-400" id="toast-spinner"></i>
    <span id="toast-text" class="text-sm">Restarting...</span>
  </div>
</div>

<script>
  // Render Lucide icons after DOM is ready.
  if (window.lucide) window.lucide.createIcons();

  // Restart handler - stays on same page, shows toast
  function doRestart() {
    if (!confirm('Restart the bot now?')) return;
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    toast.classList.remove('hidden');
    toastText.textContent = 'Restarting...';
    if (window.lucide) window.lucide.createIcons();

    fetch('/restart', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        toastText.textContent = 'Restarted! Reconnecting...';
        // Poll until server is back
        let attempts = 0;
        const poll = setInterval(() => {
          attempts++;
          fetch('/', { method: 'HEAD' })
            .then(r => {
              if (r.ok) {
                clearInterval(poll);
                toastText.textContent = 'Back online!';
                setTimeout(() => {
                  toast.classList.add('hidden');
                  location.reload();
                }, 500);
              }
            })
            .catch(() => {});
          if (attempts > 30) {
            clearInterval(poll);
            toastText.textContent = 'Taking longer than expected...';
          }
        }, 1000);
      })
      .catch(() => {
        toastText.textContent = 'Restart sent, reconnecting...';
        // Still poll for reconnect
        setTimeout(() => location.reload(), 3000);
      });
  }

  function setBotPower(poweredOn) {
    const action = poweredOn ? 'power on' : 'power off';
    if (!confirm('Are you sure you want to ' + action + ' the bot? The dashboard will stay online.')) return;
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    toast.classList.remove('hidden');
    toastText.textContent = poweredOn ? 'Powering on...' : 'Powering off...';
    fetch('/api/power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poweredOn })
    })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Power change failed');
        toastText.textContent = poweredOn ? 'Bot is back online' : 'Bot is offline — dashboard remains online';
        setTimeout(() => location.reload(), 700);
      })
      .catch(err => { toastText.textContent = err.message; });
  }

  // PWA service worker — registers the dashboard for "install as app".
  // Scoped to /, so it controls the whole site.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }

  // Theme toggle
  function toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
      html.removeAttribute('data-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      html.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    }
    updateThemeUI();
  }
  function updateThemeUI() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.querySelectorAll('.theme-icon-sun').forEach(el => el.classList.toggle('hidden', isLight));
    document.querySelectorAll('.theme-icon-moon').forEach(el => el.classList.toggle('hidden', !isLight));
    document.querySelectorAll('.theme-label').forEach(el => el.textContent = isLight ? 'Dark mode' : 'Light mode');
  }
  updateThemeUI();

  // Processing state SSE for typing indicator
  (function() {
    const indicator = document.getElementById('typing-indicator');
    const typingText = document.getElementById('typing-text');
    const mobileStatus = document.getElementById('mobile-status');
    const mobileTyping = document.getElementById('mobile-typing');
    const es = new EventSource('/processing/stream');
    es.onmessage = (e) => {
      try {
        const state = JSON.parse(e.data);
        if (state.count > 0) {
          if (indicator) indicator.classList.remove('hidden');
          if (mobileStatus) mobileStatus.classList.add('hidden');
          if (mobileTyping) mobileTyping.classList.remove('hidden');
          const first = state.active[0];
          const secs = Math.floor(first.elapsedMs / 1000);
          if (typingText) typingText.textContent = first.preview ? first.preview + '...' : 'Processing (' + secs + 's)';
        } else {
          if (indicator) indicator.classList.add('hidden');
          if (mobileStatus) mobileStatus.classList.remove('hidden');
          if (mobileTyping) mobileTyping.classList.add('hidden');
        }
      } catch {}
    };
  })();
</script>
</body>
</html>`;
};
