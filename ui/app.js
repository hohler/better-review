import { GENERATED, TEST, markdown, symbolIndex, symbolTarget, defSnippet, mdTokens, mdWrap, mdPrefix, mdEnter, mdIndent, mdLink, mdBlock, tourHunks, tourInput, normalizeTour, parseDiff, normalizeGuide, guideInput } from './lib.js';

const { invoke } = window.__TAURI__.core;
const side = document.getElementById('side');
const main = document.getElementById('main');

const load = (k, fallback) => JSON.parse(localStorage.getItem(k) ?? 'null') ?? fallback;
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
// Content always enters the DOM as text, never HTML: PR text is untrusted data.
const clean = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false);
const h = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...clean(kids));
  return e;
};
const set = (el, ...kids) => el.replaceChildren(...clean(kids));
const ago = (d) => {
  const m = (Date.now() - new Date(d)) / 60000;
  return m < 60 ? `${m | 0}m ago` : m < 1440 ? `${(m / 60) | 0}h ago` : `${(m / 1440) | 0}d ago`;
};
const highlight = (el, text, lang) => {
  // hljs escapes its output, so its result is the only HTML ever assigned.
  if (lang && window.hljs?.getLanguage(lang)) el.innerHTML = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  else el.textContent = text;
  return el;
};
// Markdown to DOM nodes. A link opens in the system browser: a plain href would navigate the app window away.
const TAGS = { b: 'strong', i: 'em', s: 'del' };
const inlineEl = (nodes) =>
  nodes.map((n) => (n.t === 'text' ? n.text : n.t === 'code' ? h('code', { textContent: n.text }) : n.t === 'link' ? h('a', { title: n.href, onclick: () => invoke('open_url', { url: n.href }).catch(() => {}) }, inlineEl(n.kids)) : h(TAGS[n.t], {}, inlineEl(n.kids))));
const blockEl = (b) => {
  if (b.type === 'code') return h('pre', {}, highlight(h('code'), b.text, b.lang));
  if (b.type === 'hr') return h('hr');
  if (b.type === 'quote') return h('blockquote', {}, b.blocks.map(blockEl));
  // Not h1-h6: those carry the app's own page styles.
  if (b.type === 'h') return h('p', { className: `mh mh${Math.min(b.level, 4)}`, role: 'heading', ariaLevel: b.level }, inlineEl(b.inline));
  if (b.type === 'table') return h('div', { className: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, inlineEl(c))))), h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inlineEl(c))))))));
  if (b.type === 'ul' || b.type === 'ol')
    return h(b.type, {}, b.items.map((i) => h('li', { className: i.checked == null ? '' : 'task' }, i.checked != null && h('input', { type: 'checkbox', checked: i.checked, disabled: true }), inlineEl(i.inline), i.blocks.map(blockEl))));
  return h('p', {}, inlineEl(b.inline));
};
const rich = (raw, className = 'text') => h('div', { className }, markdown(raw).map(blockEl));
// Progress: the backend streams Claude's answer as "ai-progress" events, keyed "guide:<key>" or "tour:<key>".
const streamed = new Map(); // id -> answer text so far
const painters = new Map(); // id -> repaint of the spinner currently showing that id
window.__TAURI__.event?.listen('ai-progress', ({ payload }) => {
  // reset: the backend starts over (a retry), so the text counted so far no longer applies.
  streamed.set(payload.id, payload.reset ? '' : (streamed.get(payload.id) ?? '') + payload.delta);
  painters.get(payload.id)?.();
});
const VERBS = ['Pondering', 'Percolating', 'Noodling', 'Cogitating', 'Musing', 'Brewing', 'Churning', 'Conjuring', 'Ruminating', 'Simmering', 'Mulling', 'Spelunking', 'Tinkering', 'Untangling', 'Deliberating', 'Marinating', 'Puzzling', 'Wrangling', 'Synthesizing', 'Crafting', 'Sleuthing', 'Finagling'];
// measure(text) returns 0..1 from the answer streamed so far; without it (or before the first item) only the verbs spin.
function spinner(label, id, measure) {
  const verb = h('b');
  const pct = h('span', { className: 'pct' });
  const bar = h('i');
  const el = h('div', { className: 'spin' }, h('span', { className: 'ring' }), h('div', {}, h('div', {}, verb, '… ', pct), h('small', { textContent: label }), measure && h('div', { className: 'bar' }, bar)));
  const turn = () => (verb.textContent = VERBS[(Math.random() * VERBS.length) | 0]);
  const paint = () => {
    const p = Math.min(0.99, measure(streamed.get(id) ?? ''));
    pct.textContent = p > 0 ? `${Math.round(p * 100)}%` : '';
    bar.style.width = `${p * 100}%`;
  };
  turn();
  if (measure) painters.set(id, paint), paint();
  const timer = setInterval(() => (el.isConnected ? turn() : clearInterval(timer)), 2600);
  return el;
}
const key = (repo, id) => `${repo}#${id}`;

// The shortcut modifier: Cmd on macOS, Ctrl elsewhere.
const MAC = navigator.platform.startsWith('Mac');
const MOD = MAC ? 'Cmd' : 'Ctrl';
const modKey = (e) => (MAC ? e.metaKey : e.ctrlKey);

let inboxes = load('inboxes', {});
// No preset workspace: the setup wizard asks for it. Installs from before the wizard keep the ones they had loaded.
let workspaces = load('workspaces', Object.keys(inboxes));
let agent = load('agent', null); // 'claude' | 'copilot', null until the wizard ran
// Claude's aliases follow the newest model of each tier, the CLI has no list. Copilot's list is asked from its CLI in Settings.
const AGENTS = [
  { id: 'claude', name: 'Claude Code', note: 'By default Sonnet writes the guide and Opus the tour.', install: 'Install the claude CLI and log in.', models: ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })), guide: 'sonnet', tour: 'opus' },
  { id: 'copilot', name: 'GitHub Copilot', note: 'On Auto, Copilot picks the model your plan allows. Each guide or tour is one premium request.', install: 'Install the copilot CLI and run "copilot login".', models: [{ id: 'auto', name: 'Auto (Copilot picks)' }], guide: 'auto', tour: 'auto' },
];
let models = load('models', {}); // agent -> { guide, tour }, missing means the agent's default
const modelFor = (kind, a = agent, chosen = models) => chosen[a]?.[kind] ?? AGENTS.find((x) => x.id === a)?.[kind];
// Appearance: 'system' follows the OS, 'light' and 'dark' pin it. The stylesheet's light-dark() colours follow color-scheme.
function applyTheme(theme = load('theme', 'system')) {
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
  // The native title bar follows too. Not available in a plain browser.
  window.__TAURI__.window?.getCurrentWindow?.().setTheme(theme === 'system' ? null : theme).catch(() => {});
}
applyTheme();
// Preloading costs one AI request per open PR, so it is opt-in.
const preloadOn = () => load('preload', false);
const errors = {};
let current = null;
const prs = new Map(); // key -> Promise<{pr, files}>
const guides = new Map(); // key -> Promise<guide>
const guideDone = new Map(); // key -> guide
let tab = 'overview';
const fileCache = new Map(); // repo@hash:path -> Promise<lines>
const tours = new Map(); // key -> Promise<tour>
const tourDone = new Map(); // key -> tour
let tourNav = null; // set while a tour stop is on screen: (delta) => move

document.addEventListener('keydown', (e) => {
  if (!tourNav || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') tourNav(1);
  else if (e.key === 'ArrowLeft') tourNav(-1);
});

const myUuid = () => Object.values(inboxes).map((i) => i.currentUser?.uuid).find(Boolean);

// The PR's participants are the source of truth for my approval, the inbox only lists the PRs.
function syncState(repo, id, pr) {
  const mine = pr.participants?.find((p) => p.user?.uuid === myUuid());
  const item = Object.values(inboxes).flatMap((i) => i.items ?? []).find((i) => i.repo === repo && i.id === id);
  const next = { approved: !!mine?.approved, participantState: mine?.state ?? null };
  if (!item || (!!item.attention?.approved === next.approved && (item.attention?.participantState ?? null) === next.participantState)) return;
  item.attention = { ...item.attention, ...next };
  save('inboxes', inboxes);
  renderSide();
}

function loadPr(repo, id) {
  const k = key(repo, id);
  if (!prs.has(k)) {
    const p = (async () => {
      const pr = JSON.parse(await invoke('pr', { repo, id }));
      syncState(repo, id, pr);
      const files = parseDiff(await invoke('diff', { repo, id, hash: pr.source.commit.hash }));
      return { pr, files };
    })();
    p.catch(() => prs.delete(k));
    prs.set(k, p);
  }
  return prs.get(k);
}

function loadGuide(repo, id) {
  const k = key(repo, id);
  if (!guides.has(k)) {
    const p = loadPr(repo, id).then(async ({ pr, files }) => {
      const raw = await invoke('guide', { key: `${repo}-${id}-${pr.source.commit.hash}`, input: guideInput(pr, files), agent, model: modelFor('guide') });
      const answer = JSON.parse(raw);
      const guide = normalizeGuide(answer, files);
      guide.meta = answer._meta;
      guideDone.set(k, guide);
      return guide;
    });
    p.catch(() => guides.delete(k));
    guides.set(k, p);
  }
  return guides.get(k);
}

// Tours are generated on first open of the Tour tab, not preloaded: they cost more than a guide.
function loadTour(repo, id) {
  const k = key(repo, id);
  if (!tours.has(k)) {
    const p = loadPr(repo, id).then(async ({ pr, files }) => {
      const raw = await invoke('tour', { key: `${repo}-${id}-${pr.source.commit.hash}`, input: tourInput(pr, files), agent, model: modelFor('tour') });
      const answer = JSON.parse(raw);
      const tour = normalizeTour(answer, files);
      tour.meta = answer._meta;
      tourDone.set(k, tour);
      return tour;
    });
    p.catch(() => tours.delete(k));
    tours.set(k, p);
  }
  return tours.get(k);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  renderSide();
  try {
    await refreshInbox();
  } finally {
    refreshing = false;
    renderSide();
  }
  // ponytail: guides preload one at a time, raise to 2-3 in parallel if the queue gets long.
  if (!preloadOn()) return;
  for (const ws of workspaces) for (const i of inboxes[ws]?.items ?? []) await loadGuide(i.repo, i.id).catch(() => {});
}

async function refreshInbox() {
  await Promise.all(
    workspaces.map(async (ws) => {
      try {
        const fresh = JSON.parse(await invoke('inbox', { workspace: ws }));
        // twg's inbox reports every PR as not approved, so keep the last known state until the PR itself is reloaded.
        const old = new Map((inboxes[ws]?.items ?? []).map((i) => [key(i.repo, i.id), i.attention]));
        for (const i of fresh.items) if (old.has(key(i.repo, i.id))) i.attention = old.get(key(i.repo, i.id));
        inboxes[ws] = fresh;
        delete errors[ws];
      } catch (e) {
        errors[ws] = String(e);
      }
      save('inboxes', inboxes);
      renderSide();
    }),
  );
  // Reload every PR for its real approval state, four at a time, before the slower guides.
  const all = workspaces.flatMap((ws) => inboxes[ws]?.items ?? []);
  for (let i = 0; i < all.length; i += 4) await Promise.all(all.slice(i, i + 4).map((p) => (key(p.repo, p.id) === current ? null : (prs.delete(key(p.repo, p.id)), loadPr(p.repo, p.id).catch(() => {})))));
}

function renderSide() {
  set(side, 
    h('header', {}, h('strong', { textContent: 'Reviews' }), refreshing && h('small', { className: 'refreshing', role: 'status', textContent: 'Refreshing…' }), h('span', {}, h('button', { textContent: '⚙', title: `Settings (${MOD}+,)`, onclick: () => openSettings(false) }), ' ', h('button', { className: refreshing ? 'busy' : '', disabled: refreshing, title: refreshing ? 'Refreshing…' : 'Refresh', onclick: refresh }, h('span', { textContent: '↻' })))),
    workspaces.map((ws) => {
      const items = inboxes[ws]?.items ?? [];
      // Two clicks, like unapprove and delete: the first arms the button for a few seconds.
      const remove = (e) => {
        const b = e.target;
        if (!b.dataset.armed) {
          b.dataset.armed = '1';
          b.textContent = 'Remove?';
          b.classList.add('warn');
          setTimeout(() => {
            delete b.dataset.armed;
            b.textContent = '×';
            b.classList.remove('warn');
          }, 4000);
          return;
        }
        workspaces = workspaces.filter((w) => w !== ws);
        delete inboxes[ws];
        save('workspaces', workspaces);
        save('inboxes', inboxes);
        renderSide();
      };
      return h(
        'section',
        {},
        h('h2', {}, ws, h('button', { textContent: '×', title: 'Remove workspace', onclick: remove })),
        errors[ws] && h('p', { className: 'error', textContent: errors[ws] }),
        [
          ['To review', items.filter((i) => !i.attention?.approved)],
          ['Approved', items.filter((i) => i.attention?.approved)],
        ].map(([label, list]) => [
          list.length > 0 && h('h3', { textContent: `${label} (${list.length})` }),
          // Repos in the order of their most recently updated PR.
          Object.entries(Object.groupBy(list.sort((a, b) => b.updatedOn.localeCompare(a.updatedOn)), (i) => i.repo)).map(([repo, prsOfRepo]) => [
            h('h4', { textContent: repo.split('/')[1] }),
            prsOfRepo.map((i) =>
              h(
                'a',
                { className: 'pr' + (current === key(i.repo, i.id) ? ' active' : ''), onclick: () => select(i.repo, i.id) },
                h('span', { textContent: `${i.attention?.approved ? '✓ ' : ''}${i.title}` }),
                i.attention?.participantState === 'changes_requested' && h('small', { className: 'warn', textContent: '● Changes requested' }),
                h('small', { textContent: `#${i.id} · ${i.author?.displayName ?? '?'} · ${ago(i.updatedOn)}` }),
              ),
            ),
          ]),
        ]),
        !items.length && !errors[ws] && h('p', { className: 'muted', textContent: inboxes[ws] ? 'No open reviews' : 'Loading…' }),
      );
    }),
    h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const ws = e.target.ws.value.trim();
          if (!/^[\w.-]+$/.test(ws) || workspaces.includes(ws)) return;
          workspaces.push(ws);
          save('workspaces', workspaces);
          renderSide();
          refresh();
        },
      },
      h('input', { name: 'ws', placeholder: '+ Add workspace' }),
    ),
  );
}

async function select(repo, id, keepScroll) {
  const k = (current = key(repo, id));
  const y = main.scrollTop;
  renderSide();
  if (!keepScroll) {
    // A newly opened PR starts on Overview, which needs no AI. Guide and Tour are written when their tab is opened.
    tab = 'overview';
    set(main, spinner('Loading the pull request'));
  }
  try {
    const data = await loadPr(repo, id);
    if (current !== k) return;
    draw(repo, id, data);
    if (keepScroll) main.scrollTop = y;
  } catch (e) {
    if (current === k) set(main, h('p', { className: 'error', textContent: String(e) }));
  }
}

// After a write, reload the PR; guide and scroll position stay.
function reload(repo, id) {
  prs.delete(key(repo, id));
  return select(repo, id, true);
}

// A plain-text Markdown editor with the two things reviews need: code insertion and a preview of how it will render.
// opts: value (prefill when editing), label (submit button), lang (language for new code blocks, e.g. the file's extension).
// The comment editor: a markdown text field with a toolbar, shortcuts and list editing. The text is shown formatted
// in place: a styled copy lies exactly behind the field, whose own text is transparent. Markers stay, only dimmed.
// quote: the code of the line being commented on, offered as "Quote line".
function commentForm(send, onCancel, { value = '', label = 'Comment', lang = '', quote } = {}) {
  const area = h('textarea', { placeholder: 'Write a comment. Markdown works.', value, rows: 3 });
  const mirror = h('pre', { className: 'mirror', ariaHidden: 'true' });
  const err = h('p', { className: 'error' });
  const btn = h('button', { className: 'primary', textContent: label });
  const refresh = () => {
    // The trailing space gives a last empty line its height in the copy.
    set(mirror, mdTokens(area.value).map((k) => (k.cls === 'cb' ? highlight(h('span', { className: 'cb' }), k.text, k.lang) : k.cls ? h('span', { className: k.cls, textContent: k.text }) : k.text)), ' ');
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  // Edits go through insertText so that undo keeps working; setRangeText is the fallback.
  const apply = (r) => {
    if (!r) return false;
    area.focus();
    area.setSelectionRange(r.from, r.to);
    if (!document.execCommand('insertText', false, r.text)) area.setRangeText(r.text, r.from, r.to, 'end');
    area.setSelectionRange(r.start, r.end);
    refresh();
    return true;
  };
  const run = (fn, ...args) => apply(fn(area.value, area.selectionStart, area.selectionEnd, ...args));
  const tool = (content, title, keys, action, props = {}) => {
    const b = h('button', { type: 'button', title: keys ? `${title} (${keys})` : title, onclick: action, ...props });
    b.append(content);
    return b;
  };
  const actions = {
    b: () => run(mdWrap, '**'),
    i: () => run(mdWrap, '_'),
    e: () => run(mdWrap, '`', '`', 'code'),
    k: () => run(mdLink),
    C: () => run(mdBlock, lang),
  };
  const bar = h(
    'div',
    { className: 'bar' },
    tool(h('b', { textContent: 'B' }), 'Bold', `${MOD}+B`, actions.b),
    tool(h('i', { textContent: 'I' }), 'Italic', `${MOD}+I`, actions.i),
    tool(h('s', { textContent: 'S' }), 'Strikethrough', '', () => run(mdWrap, '~~')),
    h('span', { className: 'sep' }),
    tool('`c`', 'Inline code', `${MOD}+E`, actions.e, { className: 'mono' }),
    tool('{ }', 'Code block', `${MOD}+Shift+C`, actions.C, { className: 'mono' }),
    quote != null && tool('Quote line', 'Insert the line you are commenting on as a code block', '', () => run(mdBlock, lang, quote)),
    h('span', { className: 'sep' }),
    tool('Link', 'Link', `${MOD}+K`, actions.k),
    tool('• List', 'Bullet list', '', () => run(mdPrefix, 'ul')),
    tool('1. List', 'Numbered list', '', () => run(mdPrefix, 'ol')),
    tool('☐ Task', 'Task list', '', () => run(mdPrefix, 'task')),
    tool('❝', 'Quote', '', () => run(mdPrefix, 'quote')),
    h('span', { className: 'grow' }),
    h('small', { textContent: 'Markdown' }),
  );
  // Two ways to send a new comment: post it now, or keep it pending as part of a review. Editing only saves.
  const later = !value && h('button', { type: 'button', textContent: 'Add to review', title: 'Saved as pending: only you see it until you finish the review in Bitbucket', onclick: () => go(true) });
  const form = h(
    'form',
    { className: 'comment' },
    h('div', { className: 'ed' }, bar, h('div', { className: 'pad' }, mirror, area)),
    h('div', { className: 'foot' }, btn, later, onCancel && h('button', { type: 'button', textContent: 'Cancel', onclick: onCancel }), h('small', { textContent: `${MOD}+Enter to send` })),
    err,
  );
  const go = async (pending) => {
    if (!area.value.trim() || btn.disabled) return;
    btn.disabled = true;
    if (later) later.disabled = true;
    try {
      await send(area.value, pending);
    } catch (ex) {
      err.textContent = String(ex);
      btn.disabled = false;
      if (later) later.disabled = false;
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    go(false);
  };
  const PAIRS = { '`': '`', '*': '*', _: '_', '(': ')', '[': ']' };
  area.onkeydown = (e) => {
    const done = (ok) => ok && e.preventDefault();
    const selected = area.selectionStart !== area.selectionEnd;
    // Cmd+B, I, E, K and Cmd+Shift+C. Plain Cmd+C stays copy.
    const letter = e.key.toLowerCase();
    const shortcut = modKey(e) && !e.altKey ? (e.shiftKey ? (letter === 'c' ? 'C' : '') : letter) : '';
    if (modKey(e) && e.key === 'Enter') form.requestSubmit();
    else if (actions[shortcut]) done((actions[shortcut](), true));
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) done(run(mdEnter));
    // Tab only acts in lists and code blocks. Elsewhere it keeps moving focus, so the form stays keyboard friendly.
    else if (e.key === 'Tab' && !modKey(e)) done(run(mdIndent, e.shiftKey));
    // Typing a bracket or marker with text selected wraps the selection.
    else if (selected && PAIRS[e.key] && !modKey(e)) done(run(mdWrap, e.key, PAIRS[e.key]));
    // Esc closes a reply or edit, but never throws away something typed.
    else if (e.key === 'Escape' && onCancel && area.value === value) onCancel();
  };
  // Pasting a web address onto selected text makes that text a link.
  area.onpaste = (e) => {
    const url = e.clipboardData?.getData('text').trim() ?? '';
    if (area.selectionStart !== area.selectionEnd && /^https:\/\/\S+$/.test(url)) e.preventDefault(), run(mdLink, url);
  };
  area.oninput = refresh;
  setTimeout(() => (refresh(), onCancel && area.focus()));
  return form;
}

function threadEl(root, comments, post, lang) {
  const ids = new Set([root.id]);
  const all = [root];
  for (const c of comments) if (c.parent && ids.has(c.parent.id)) ids.add(c.id), all.push(c); // comments arrive in chronological order
  const slot = h('div');
  const reply = h('button', {
    textContent: 'Reply',
    onclick: () => set(slot, commentForm((text, pending) => post({ text, pending, replyTo: root.id }), () => set(slot, reply), { lang })),
  });
  slot.append(reply);
  const item = (c) => {
    const text = c.content?.raw ?? '';
    const body = h('div', {}, rich(text));
    const edit = h('a', { textContent: 'Edit', onclick: () => set(body, commentForm((t) => post({ edit: c.id, text: t }), () => set(body, rich(text)), { value: text, label: 'Save', lang })) });
    // Deleting cannot be undone on Bitbucket, so it takes a second click within 4 seconds.
    const del = h('a', { textContent: 'Delete' });
    del.onclick = () => {
      if (!del.dataset.armed) {
        del.dataset.armed = '1';
        del.textContent = 'Click again to delete';
        del.classList.add('minus');
        setTimeout(() => {
          if (!del.isConnected || del.dataset.armed === 'go') return;
          delete del.dataset.armed;
          del.textContent = 'Delete';
          del.classList.remove('minus');
        }, 4000);
        return;
      }
      if (del.dataset.armed === 'go') return;
      del.dataset.armed = 'go';
      del.textContent = 'Deleting…';
      post({ remove: c.id }).catch((e) => (del.textContent = String(e)));
    };
    const mine = c.user?.uuid && c.user.uuid === myUuid();
    return h('div', { className: 'comment' }, h('div', { className: 'chead' }, h('b', { textContent: c.user?.display_name ?? '?' }), h('small', { textContent: `${ago(c.created_on)}${c === root && root.resolution ? ' · resolved' : ''}` }), c.pending && h('span', { className: 'tag pending', textContent: 'Pending', title: 'Only you see this until you finish the review in Bitbucket' }), h('span', { className: 'grow' }), mine && [edit, del]), body);
  };
  return h('div', { className: 'thread' + (root.resolution ? ' resolved' : '') }, all.map(item), slot);
}

// The facts about a PR, in a column beside the overview: where it stands, who reviews it, how big it is, what it touches.
function infoEl(pr, files, reviewed, mine, openFile) {
  const order = { changes_requested: 0, approved: 1 };
  // Reviewers, plus anyone else who approved or asked for changes.
  const people = (pr.participants ?? []).filter((p) => (p.role === 'REVIEWER' || p.state) && p.user?.uuid !== pr.author?.uuid).sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2));
  const person = (p) => {
    const [mark, label, cls] = p.state === 'approved' ? ['✓', 'Approved', 'plus'] : p.state === 'changes_requested' ? ['●', 'Changes requested', 'warn'] : ['○', 'Not reviewed yet', 'muted'];
    return h('div', { className: 'who', title: label }, h('span', { className: cls, textContent: mark }), h('span', { textContent: p.user?.uuid === myUuid() ? 'You' : (p.user?.display_name ?? '?') }), p.state === 'changes_requested' && h('small', { className: 'warn', textContent: 'changes requested' }));
  };
  const yours = !mine ? null : mine.state === 'approved' ? ['You approved', 'plus'] : mine.state === 'changes_requested' ? ['You requested changes', 'warn'] : ['Waiting for your review', ''];
  const sum = (k) => files.reduce((n, f) => n + f[k], 0);
  const done = files.filter((f) => reviewed.has(f.path)).length;
  const part = (label, ...kids) => h('section', {}, h('h4', { textContent: label }), kids);
  // Builds come with the PR, one per pipeline or check. Problems first, each linked to its page.
  const BUILD = { FAILED: ['✕', 'Failed', 'minus', 0], STOPPED: ['✕', 'Stopped', 'minus', 0], INPROGRESS: ['◌', 'Running', 'warn', 1], SUCCESSFUL: ['✓', 'Passed', 'plus', 2] };
  const builds = (pr._statuses ?? []).map((b) => ({ ...b, look: BUILD[b.state] ?? ['○', b.state ?? 'Unknown', 'muted', 3] })).sort((a, b) => a.look[3] - b.look[3]);
  const build = (b) =>
    h(
      'div',
      { className: 'who', title: `${b.look[1]}: ${b.name ?? b.key ?? ''}` },
      h('span', { className: b.look[2], textContent: b.look[0] }),
      b.url ? h('a', { className: 'name', textContent: b.name ?? b.key ?? 'Build', onclick: () => invoke('open_url', { url: b.url }).catch(() => {}) }) : h('span', { className: 'name', textContent: b.name ?? b.key ?? 'Build' }),
      b.updated_on && h('small', { textContent: ago(b.updated_on) }),
    );
  return h(
    'aside',
    { className: 'info' },
    part('Status', h('div', { className: 'who' }, h('span', { textContent: pr.state === 'OPEN' || !pr.state ? 'Open' : pr.state[0] + pr.state.slice(1).toLowerCase() }), yours && h('span', { className: `tag ${yours[1]}`, textContent: yours[0] }))),
    people.length > 0 && part('Reviewers', people.map(person)),
    part('Builds', builds.length ? builds.map(build) : h('div', { className: 'who muted', textContent: 'No builds for this pull request' })),
    part('Changes', h('div', { className: 'who' }, h('span', { textContent: `${files.length} file${files.length === 1 ? '' : 's'}` }), h('span', { className: 'stats' }, h('span', { className: 'plus', textContent: `+${sum('added')}` }), ' ', h('span', { className: 'minus', textContent: `−${sum('removed')}` })))),
    part('Reviewed by you', h('div', { className: 'who' }, h('span', { textContent: `${done} of ${files.length} files` })), h('div', { className: 'meter' }, h('i', { style: `width:${files.length ? (done / files.length) * 100 : 0}%` }))),
    part('Updated', h('div', { className: 'who' }, h('span', { textContent: ago(pr.updated_on) }))),
    part(
      'Files',
      files.map((f) => {
        const name = f.path.split('/').pop();
        return h('a', { className: 'frow' + (reviewed.has(f.path) ? ' done' : ''), title: f.path, onclick: () => openFile(f.path) }, icon(name), h('span', { className: f.status === 'added' ? 'plus' : '', textContent: name }), h('span', { className: 'dir', textContent: f.path.slice(0, -name.length) }), h('span', { className: 'stats' }, stats(f)));
      }),
    ),
  );
}

// Small centred line under a guide or tour: which agent and model wrote it, and what that request used.
// The numbers are from when it was written. Showing it again from the cache costs nothing.
function aiFooter(meta) {
  if (!meta) return null;
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const parts = [
    meta.agent === 'copilot' ? 'GitHub Copilot' : 'Claude Code',
    meta.model,
    meta.input || meta.output ? `${k(meta.input)} tokens in, ${k(meta.output)} out` : null,
    meta.seconds ? `${Math.round(meta.seconds)} s` : null,
    typeof meta.cost === 'number' ? `$${meta.cost.toFixed(2)}` : null,
    typeof meta.premium === 'number' ? `${meta.premium} premium request${meta.premium === 1 ? '' : 's'}` : null,
    meta.at ? `written ${ago(meta.at)}` : null,
  ];
  return h('p', { className: 'aifoot', title: 'Usage of the one request that wrote this. It is cached, so reopening it costs nothing.', textContent: parts.filter(Boolean).join(' · ') });
}

const pad = (n) => String(n).padStart(2, '0');
const split = (path) => [path.slice(path.lastIndexOf('/') + 1), path.slice(0, path.lastIndexOf('/') + 1)];
const stats = (f) => [f.added > 0 && h('span', { className: 'plus', textContent: `+${f.added}` }), f.removed > 0 && h('span', { className: 'minus', textContent: ` -${f.removed}` })];
const check = (checked, onchange) => h('label', { className: 'check' }, h('input', { type: 'checkbox', checked, onchange }), 'Reviewed');

// ponytail: lettered badges instead of an icon pack. Swap in real SVG icons here if the look matters more.
const TYPES = {
  ts: ['TS', '#3178c6'], tsx: ['⚛\uFE0E', '#149eca'], js: ['JS', '#c9a700'], mjs: ['JS', '#c9a700'], cjs: ['JS', '#c9a700'], jsx: ['⚛\uFE0E', '#c9a700'],
  css: ['#', '#8b5cf6'], scss: ['#', '#c6538c'], less: ['#', '#8b5cf6'], html: ['<>', '#e34c26'], vue: ['V', '#41b883'], svelte: ['S', '#ff3e00'],
  json: ['{}', '#8a8f98'], yml: ['Y', '#8a8f98'], yaml: ['Y', '#8a8f98'], toml: ['T', '#8a8f98'], xml: ['<>', '#8a8f98'], lock: ['L', '#8a8f98'],
  md: ['M', '#4b5563'], mdx: ['M', '#4b5563'], sh: ['$', '#4b5563'], sql: ['DB', '#0f766e'],
  py: ['PY', '#3572a5'], rs: ['RS', '#b7410e'], go: ['GO', '#00add8'], kt: ['KT', '#7f52ff'], swift: ['SW', '#f05138'], java: ['JV', '#b07219'], php: ['PH', '#777bb4'], rb: ['RB', '#cc342d'], dart: ['D', '#0175c2'], cs: ['C#', '#178600'],
  png: ['▣', '#0d9488'], jpg: ['▣', '#0d9488'], jpeg: ['▣', '#0d9488'], gif: ['▣', '#0d9488'], webp: ['▣', '#0d9488'], svg: ['▣', '#0d9488'],
};
// File type badge; inside a card header it turns into a chevron on hover (see style.css).
const icon = (name) => {
  const [label, color] = TYPES[name.split('.').pop().toLowerCase()] ?? ['·', '#8a8f98'];
  const badge = h('i', { className: 'ft', textContent: label });
  badge.style.background = color;
  return h('span', { className: 'ficon' }, badge, h('i', { className: 'chev', textContent: '›' }));
};

// hidden: null (show diff) or the reason shown in the placeholder, e.g. "Test files".
// only: optional Set of hunks, to show just a part of the file (tour stops).
// Turns each use of a symbol defined in this PR into a link to its definition. Comments and strings are left alone.
function linkSymbols(cell, path, line, index) {
  const texts = [];
  for (const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT); w.nextNode(); ) if (!w.currentNode.parentElement.closest('.hljs-comment, .hljs-string')) texts.push(w.currentNode);
  for (const node of texts) {
    const parts = [];
    let last = 0;
    for (const m of node.data.matchAll(index.pattern)) {
      const target = symbolTarget(index, m[0], path, line);
      if (!target) continue;
      parts.push(node.data.slice(last, m.index), h('a', { className: 'sym', title: `Go to definition: ${target.path}:${target.line}`, textContent: m[0], onclick: (e) => (e.stopPropagation(), (index.open ?? goToLine)(target, e.currentTarget)) }));
      last = m.index + m[0].length;
    }
    if (parts.length) node.replaceWith(...parts.flat(), node.data.slice(last));
  }
}

// Opens the file if needed, scrolls the line to the middle and marks it for a moment. False if the line is not on screen.
function flashLine({ path, line }) {
  const card = document.getElementById(`f-${path}`);
  if (!card) return false;
  if (card.querySelector(':scope > .body[hidden], .placeholder')) card.show();
  const row = card.querySelector(`tr[data-n="${line}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 3200);
  return true;
}
// One floating button that undoes the last jump.
function backChip(label, action) {
  document.querySelector('.backchip')?.remove();
  const chip = h('button', { className: 'backchip', textContent: label, onclick: () => (chip.remove(), action()) });
  document.body.append(chip);
  setTimeout(() => chip.remove(), 20000);
}
function goToLine(target) {
  const from = main.scrollTop;
  if (flashLine(target)) backChip('↩ Back', () => (main.scrollTop = from));
  else document.getElementById(`f-${target.path}`)?.scrollIntoView({ block: 'start' });
}

// The tour's answer to "where is this defined": a small card under the clicked name instead of a jump away.
let closeDef = null;
function defPopover(anchor, file, target, snippet, footer) {
  const same = closeDef?.anchor === anchor;
  closeDef?.();
  if (same) return;
  const name = file.path.split('/').pop();
  const lang = name.split('.').pop();
  const pop = h(
    'div',
    { className: 'defpop', role: 'dialog', ariaLabel: `Definition in ${file.path}` },
    h('header', {}, icon(name), h('b', { textContent: name }), h('span', { className: 'dir', textContent: `${file.path.slice(0, -name.length)} · line ${target.line}` }), h('button', { className: 'x', type: 'button', textContent: '×', title: 'Close (Esc)', onclick: () => closeDef?.() })),
    h('div', { className: 'scroll' }, h('table', { className: 'diff' }, h('tbody', {}, snippet.lines.map((l) => h('tr', { className: l.t === '+' ? 'add' : '' }, h('td', { className: 'no plain', textContent: l.n }), highlight(h('td', { className: 'code' }), l.text, lang))), snippet.more && h('tr', { className: 'gap' }, h('td', { colSpan: 2, textContent: 'The definition continues. Open it in the diff to see all of it.' }))))),
    h('footer', {}, footer),
  );
  // Placed under the name, inside the scrolling area so it moves with the code.
  const box = main.getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  const width = Math.min(680, main.clientWidth - 64);
  pop.style.width = `${width}px`;
  pop.style.top = `${at.bottom - box.top + main.scrollTop + 8}px`;
  pop.style.left = `${Math.max(32, Math.min(at.left - box.left - 44, main.clientWidth - width - 32))}px`;
  const onKey = (e) => e.key === 'Escape' && closeDef?.();
  const onClick = (e) => !pop.contains(e.target) && e.target !== anchor && closeDef?.();
  closeDef = () => {
    pop.remove();
    anchor.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onClick, true);
    closeDef = null;
  };
  closeDef.anchor = anchor;
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick, true);
  anchor.classList.add('open');
  main.append(pop);
}

function fileEl(f, hidden, ctx, only) {
  const { comments, post, reviewed, toggle } = ctx;
  const roots = comments.filter((c) => !c.parent && c.inline?.path === f.path);
  const [name, dir] = split(f.path);
  const done = !ctx.tour && reviewed.has(f.path);
  const body = h('div', { className: 'body' });
  const card = h(
    'div',
    { className: 'file' + (done ? ' done' : ''), id: `f-${f.path}` },
    h(
      'header',
      {
        // Block body on purpose: an on* handler returning false would cancel the checkbox click.
        onclick: (e) => {
          if (e.target.closest('label')) return;
          if (body.hidden || body.querySelector('.placeholder')) show();
          else body.hidden = true;
        },
      },
      icon(name),
      h('b', { className: f.status === 'added' ? 'plus' : f.status === 'deleted' ? 'minus' : '', textContent: name }),
      h('span', { className: 'dir', textContent: f.status === 'renamed' ? `${dir} (was ${f.oldPath})` : dir }),
      roots.length > 0 && h('span', { className: 'tag', textContent: `${roots.length} comment${roots.length > 1 ? 's' : ''}` }),
      h('span', { className: 'stats' }, stats(f)),
      // Marking a file whose top is already scrolled out of view collapses it, so jump to the next file.
      only && only.size < f.hunks.length && h('span', { className: 'tag', textContent: `${only.size} of ${f.hunks.length} hunks` }),
      !ctx.tour && check(done, () => toggle([f.path], !done, !done && card.getBoundingClientRect().top < main.getBoundingClientRect().top + 56 && card.id)),
    ),
    body,
  );
  const lang = name.split('.').pop();
  // Build the diff on first reveal, so hidden (test, generated, reviewed) files cost nothing.
  const show = () => {
    body.hidden = false;
    if (body.dataset.done) return;
    body.dataset.done = '1';
    if (f.binary) return set(body, h('p', { className: 'muted', textContent: 'Binary file' }));
    if (!f.hunks.length && !roots.length) return set(body, h('p', { className: 'muted', textContent: 'No text changes' }));
    const placed = new Set();
    const note = (...kids) => h('tr', { className: 'note' }, h('td', { colSpan: 2 }, kids));
    const tbody = h('tbody');
    // A gap row loads the file at the PR's commit on click and swaps itself for lines from..to (to = null: end of file).
    const expander = (from, to, label) => {
      const cell = h('td', { colSpan: 2, textContent: label, title: 'Show unchanged lines' });
      const tr = h('tr', { className: 'gap' }, cell);
      tr.onclick = async () => {
        cell.textContent = 'Loading…';
        try {
          const all = await ctx.fileLines(f.path);
          // Line numbers are not clickable here: Bitbucket only takes inline comments on lines inside the diff.
          tr.replaceWith(...all.slice(from - 1, to ?? all.length).map((text, i) => h('tr', {}, h('td', { className: 'no plain', textContent: from + i }), highlight(h('td', { className: 'code' }), text, lang))));
        } catch (e) {
          cell.textContent = `Could not load the file: ${e}`;
        }
      };
      return tr;
    };
    let end = 0; // last new-side line of the previous hunk
    let skipped = false; // a hunk outside this tour stop lies in the gap before the next shown hunk
    for (const hunk of f.hunks) {
      if (only && !only.has(hunk)) {
        skipped = true;
        continue;
      }
      const gap = hunk.start - end - 1;
      if (gap > 0) tbody.append(expander(end + 1, hunk.start - 1, skipped ? `↕ ${gap} line${gap > 1 ? 's' : ''} not in this stop` : `↕ ${gap} unchanged line${gap > 1 ? 's' : ''}`));
      end = hunk.start + hunk.count - 1;
      skipped = false;
      for (const l of hunk.lines) {
        const row = h('tr', { className: l.t === '+' ? 'add' : l.t === '-' ? 'del' : '' });
        const anchor = l.t === '-' ? { fromLine: l.o } : { line: l.n };
        const start = () => {
          if (row.nextSibling?.dataset.form) return row.nextSibling.remove();
          const tr = note(commentForm((text, pending) => post({ text, pending, path: f.path, ...anchor }), () => tr.remove(), { lang, quote: l.text }));
          tr.dataset.form = '1';
          row.after(tr);
        };
        const code = highlight(h('td', { className: 'code' }), l.text, lang);
        if (l.n != null) row.dataset.n = l.n;
        if (ctx.symbols?.pattern && l.t !== '-') linkSymbols(code, f.path, l.n, ctx.symbols);
        row.append(h('td', { className: 'no', textContent: l.n ?? '−', title: 'Comment on this line', onclick: start }), code);
        tbody.append(row);
        const here = roots.filter((c) => !placed.has(c) && (c.inline.to != null ? l.n === c.inline.to : l.t !== '+' && l.o === c.inline.from));
        if (here.length) tbody.append(note(here.map((c) => (placed.add(c), threadEl(c, comments, post, lang)))));
      }
    }
    if (f.hunks.length && f.status !== 'added' && f.status !== 'deleted') tbody.append(expander(end + 1, null, only ? '↕ Show the rest of the file' : '↕ Show unchanged lines below'));
    const outdated = roots.filter((c) => !placed.has(c));
    if (outdated.length && !only) tbody.prepend(note(h('small', { textContent: 'Comments outside the current diff' }), outdated.map((c) => threadEl(c, comments, post, lang))));
    set(body, h('div', { className: 'scroll' }, h('table', { className: 'diff' }, tbody)));
  };
  card.show = show;
  if (done) body.hidden = true;
  else if (hidden) set(body, h('div', { className: 'placeholder' }, h('p', { textContent: `${hidden} are not shown by default` }), h('button', { textContent: 'Show diff', onclick: show })));
  else show();
  return card;
}

const barWatch = new ResizeObserver(([entry]) => main.style.setProperty('--bar', `${Math.round(entry.borderBoxSize[0].blockSize)}px`));

function draw(repo, id, data, guide) {
  closeDef?.();
  const { pr, files } = data;
  guide ??= guideDone.get(key(repo, id)); // may have arrived since the caller looked (background preparation)
  tourNav = null;
  const aiKey = `${repo}-${id}-${pr.source.commit.hash}`; // same key the backend gets, so progress events match
  const core = files.filter((f) => !GENERATED.test(f.path));
  const g = guide ?? normalizeGuide(null, files);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  const comments = (pr._comments ?? []).filter((c) => !c.deleted);
  const general = comments.filter((c) => !c.parent && !c.inline);
  const pendingCount = comments.filter((c) => c.pending).length;
  const mine = pr.participants?.find((p) => p.user?.uuid === myUuid());
  const changes = mine?.state === 'changes_requested';
  const redraw = () => {
    const y = main.scrollTop;
    draw(repo, id, data, guide);
    main.scrollTop = y;
  };

  // Reviewed marks live per commit, so a new push asks for a fresh look.
  const rkey = `reviewed:${repo}#${id}:${pr.source.commit.hash}`;
  const reviewed = new Set(load(rkey, []));
  const toggle = (paths, on, nextAfter) => {
    for (const p of paths) on ? reviewed.add(p) : reviewed.delete(p);
    save(rkey, [...reviewed]);
    redraw();
    if (!nextAfter) return;
    const cards = [...main.querySelectorAll('.file')];
    const i = cards.findIndex((c) => c.id === nextAfter);
    (cards[i + 1] ?? cards[i]).scrollIntoView({ block: 'start' });
  };
  // One write path for comments: new or reply ({ text, ... }), edit ({ edit: commentId, text }), delete ({ remove: commentId }).
  const post = async (args) => {
    if (args.remove) await invoke('comment_delete', { repo, id, comment: args.remove });
    else if (args.edit) await invoke('comment_update', { repo, id, comment: args.edit, text: args.text });
    else await invoke('comment', { repo, id, ...args });
    await reload(repo, id);
  };
  const act = (action) => async (e) => {
    // Taking back an approval needs a second click within 4 seconds, so a stray click cannot do it.
    if (action === 'unapprove' && !e.target.dataset.armed) {
      const b = e.target;
      const label = b.textContent;
      b.dataset.armed = '1';
      b.textContent = 'Click again to unapprove';
      b.classList.add('warn');
      setTimeout(() => {
        if (!b.isConnected || b.disabled) return;
        delete b.dataset.armed;
        b.textContent = label;
        b.classList.remove('warn');
      }, 4000);
      return;
    }
    e.target.disabled = true;
    try {
      await invoke('review', { repo, id, action });
      await reload(repo, id);
    } catch (ex) {
      e.target.disabled = false;
      alert(ex);
    }
  };
  const fileLines = (path) => {
    const src = pr.source.repository?.full_name ?? repo; // forks keep the source commit in their own repo
    const k = `${src}@${pr.source.commit.hash}:${path}`;
    if (!fileCache.has(k)) {
      const p = invoke('file', { repo: src, path, hash: pr.source.commit.hash }).then((t) => t.replace(/\n$/, '').split('\n'));
      p.catch(() => fileCache.delete(k));
      fileCache.set(k, p);
    }
    return fileCache.get(k);
  };
  const ctx = { comments, post, reviewed, toggle, fileLines, symbols: symbolIndex(files) };
  const generated = new Set(g.generated);
  const why = (p) => (generated.has(p) ? 'Generated files' : TEST.test(p) ? 'Test files' : byPath[p].added + byPath[p].removed > 1500 ? 'Large diffs' : null);
  const card = (p) => fileEl(byPath[p], why(p), ctx);
  const jump = (p) => () => {
    const el = document.getElementById(`f-${p}`);
    el.show();
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const steps = [...g.groups, ...(g.generated.length ? [{ title: 'Generated files', summary: 'Machine generated. Collapsed by default.', files: g.generated }] : [])];
  const step = (grp, i) => {
    const all = grp.files.every((p) => reviewed.has(p));
    return h(
      'section',
      { className: 'step' },
      h(
        'aside',
        {},
        h('h2', { textContent: grp.title }),
        h('div', { className: 'count' }, `${pad(i + 1)} / ${pad(steps.length)}`, check(all, () => toggle(grp.files, !all))),
        grp.summary && rich(grp.summary, 'text summary'),
        grp.files.map((p) => {
          const [name, dir] = split(p);
          return h('a', { className: 'frow' + (reviewed.has(p) ? ' done' : ''), onclick: jump(p) }, icon(name), h('span', { className: byPath[p].status === 'added' ? 'plus' : '', textContent: name }), h('span', { className: 'dir', textContent: dir }), h('span', { className: 'stats' }, stats(byPath[p])));
        }),
      ),
      h('div', { className: 'cards' }, grp.files.map(card)),
    );
  };
  const tourView = () => {
    const k = key(repo, id);
    const t = tourDone.get(k);
    if (!t) {
      // Tour progress: share of hunk ids the answer has already placed in a stop.
      const total = tourHunks(files).length || 1;
      const box = h('div', { className: 'tour' }, spinner('Preparing the tour. A large pull request takes about a minute.', `tour:${aiKey}`, (text) => new Set(text.match(/"H\d+"/g)).size / total));
      loadTour(repo, id).then(
        () => current === k && tab === 'tour' && box.isConnected && draw(repo, id, data, guide),
        (e) => box.isConnected && set(box, h('p', { className: 'error', textContent: `Tour failed: ${e}` }), h('button', { textContent: 'Try again', onclick: () => draw(repo, id, data, guide) })),
      );
      return box;
    }
    // Position 0 is the briefing, 1..n are the stops, n+1 is the wrap-up.
    const tkey = `tour:${repo}#${id}:${pr.source.commit.hash}`;
    const state = load(tkey, { i: 0, done: [] });
    const last = t.stops.length + 1;
    const i = Math.min(state.i, last);
    const done = new Set(state.done);
    const stopFiles = (s) => [...s.parts.map((p) => p.path), ...s.files];
    const go = (n, mark) => {
      if (mark && i > 0 && i < last) {
        done.add(i);
        // A file counts as reviewed once every stop showing a part of it has been passed.
        for (const p of stopFiles(t.stops[i - 1])) if (t.stops.every((s, j) => !stopFiles(s).includes(p) || done.has(j + 1))) reviewed.add(p);
        save(rkey, [...reviewed]);
      }
      save(tkey, { i: Math.max(0, Math.min(n, last)), done: [...done] });
      draw(repo, id, data, guide);
    };
    tourNav = (d) => go(i + d, d > 0);
    // In the tour a symbol link does not jump away: a definition outside the current stop opens in a popover.
    const stopOf = ({ path, line }) => t.stops.findIndex((x) => x.files.includes(path) || x.parts.some((p) => p.path === path && p.hunks.some((hk) => hk.lines.some((l) => l.n === line)))) + 1;
    const openDef = (target, anchor) => {
      if (document.getElementById(`f-${target.path}`)?.querySelector(`tr[data-n="${target.line}"]`)) return closeDef?.(), goToLine(target);
      const snippet = defSnippet(byPath[target.path], target.line);
      if (!snippet) return;
      const n = stopOf(target);
      const where = !n ? '' : done.has(n) ? `✓ You saw this in stop ${n}` : n > i ? `Comes up in stop ${n}` : `Shown in stop ${n}`;
      defPopover(anchor, byPath[target.path], target, snippet, [
        h('small', { textContent: where }),
        n > 0 && h('button', { type: 'button', textContent: `Go to stop ${n}`, title: t.stops[n - 1].title, onclick: () => (go(n), flashLine(target), backChip(`↩ Back to stop ${i}`, () => go(i))) }),
        h('button', { type: 'button', textContent: 'Open in Diff', onclick: () => ((tab = 'diff'), draw(repo, id, data, guide), flashLine(target), backChip('↩ Back to the tour', () => ((tab = 'tour'), draw(repo, id, data, guide)))) }),
      ]);
    };
    const tctx = { ...ctx, tour: true, symbols: { ...ctx.symbols, open: openDef } };
    const s = t.stops[i - 1];
    const body =
      i === 0
        ? [
            h('h2', { textContent: 'Briefing' }),
            rich(t.briefing || 'No briefing available.', 'lead text'),
            h('h3', { textContent: 'Route' }),
            h('ol', { className: 'route' }, t.stops.map((x, j) => h('li', { className: done.has(j + 1) ? 'done' : '' }, h('a', { textContent: x.title, onclick: () => go(j + 1) }), h('small', { textContent: ` ${stopFiles(x).length} file${stopFiles(x).length > 1 ? 's' : ''}` })))),
          ]
        : i === last
          ? [
              h('h2', { textContent: 'Wrap-up' }),
              h('p', { className: 'lead', textContent: done.size >= t.stops.length ? `You have been through all ${t.stops.length} stops.` : `You have been through ${done.size} of ${t.stops.length} stops. Skipped stops are marked in the bar above.` }),
              t.questions.length > 0 && [h('h3', { textContent: 'Worth raising with the author' }), h('ul', {}, t.questions.map((q) => h('li', {}, rich(q))))],
              h('h3', { textContent: 'Leave a general comment' }),
              commentForm((text, pending) => post({ text, pending })),
              h('div', { className: 'verdict' }, h('button', { className: changes ? 'ask on' : 'ask', textContent: changes ? '● Changes requested' : 'Request changes', onclick: act(changes ? 'remove-request-changes' : 'request-changes') }), h('button', { className: mine?.approved ? 'on' : 'primary', textContent: mine?.approved ? '✓ Approved' : 'Approve', onclick: act(mine?.approved ? 'unapprove' : 'approve') })),
            ]
          : [
              h('h2', { textContent: s.title }),
              rich(s.explanation, 'lead text'),
              s.check && h('div', { className: 'checkbox' }, h('b', { textContent: 'Check ' }), rich(s.check)),
              h('div', { className: 'cards' }, s.parts.map((p) => fileEl(byPath[p.path], null, tctx, new Set(p.hunks))), s.files.map((p) => fileEl(byPath[p], why(p), tctx))),
            ];
    return h(
      'div',
      { className: 'tour' },
      h(
        'div',
        { className: 'progress' },
        Array.from({ length: last + 1 }, (_, j) => h('a', { className: (j === i ? 'now ' : '') + (done.has(j) || j === 0 ? 'done' : ''), title: j === 0 ? 'Briefing' : j === last ? 'Wrap-up' : t.stops[j - 1].title, onclick: () => go(j) })),
        h('span', { textContent: i === 0 ? 'Briefing' : i === last ? 'Wrap-up' : `Stop ${i} of ${t.stops.length}` }),
      ),
      body,
      aiFooter(t.meta),
      h(
        'div',
        { className: 'tournav' },
        i > 0 && h('button', { textContent: '← Back', onclick: () => go(i - 1) }),
        h('span', { className: 'grow' }),
        h('small', { textContent: 'Arrow keys work too' }),
        i > 0 && i < last && h('button', { textContent: 'Skip', onclick: () => go(i + 1) }),
        i < last && h('button', { className: 'primary', textContent: i === 0 ? 'Start the tour →' : 'Looks good, next →', onclick: () => go(i + 1, true) }),
      ),
    );
  };
  // Issue keys like TVP-27172 in the title link to the Jira site named after the Bitbucket workspace.
  const title = pr.title.split(/\b([A-Z][A-Z0-9]+-\d+)\b/).map((part, n) => (n % 2 ? h('a', { textContent: part, title: 'Open in Jira', onclick: () => invoke('open_url', { url: `https://${repo.split('/')[0]}.atlassian.net/browse/${part}` }) }) : part));
  const views = {
    overview: () =>
      h(
        'div',
        { className: 'over' },
        h(
          'div',
          {},
          guide && rich(g.summary, 'lead text'),
          pr.description && h('div', { className: 'box' }, h('h3', { textContent: 'Description' }), rich(pr.description)),
          h('div', { className: 'box' }, h('h3', { textContent: `Discussion (${general.length})` }), general.map((c) => threadEl(c, comments, post)), commentForm((text, pending) => post({ text, pending }))),
        ),
        infoEl(pr, files, reviewed, mine, (path) => {
          tab = 'diff';
          draw(repo, id, data, guide);
          const el = document.getElementById(`f-${path}`);
          el?.show();
          el?.scrollIntoView({ block: 'start' });
        }),
      ),
    // The guide is requested here, on first open of the tab, so opening a PR alone never spends an AI request.
    guide: () => {
      if (guide) return [steps.map(step), aiFooter(guide.meta)];
      const k = key(repo, id);
      // Progress: share of source files the answer has already placed in a group.
      const box = h('div', { className: 'guide' }, spinner('Preparing the review guide', `guide:${aiKey}`, (text) => core.filter((f) => text.includes(JSON.stringify(f.path))).length / (core.length || 1)));
      loadGuide(repo, id).then(
        () => current === k && tab === 'guide' && box.isConnected && draw(repo, id, data),
        (e) => box.isConnected && set(box, h('p', { className: 'error', textContent: `Guide failed: ${e}` }), h('button', { textContent: 'Try again', onclick: () => draw(repo, id, data) })),
      );
      return box;
    },
    tour: tourView,
    diff: () => h('div', { className: 'cards' }, files.map((f) => card(f.path))),
  };

  set(
    main,
    h(
      'div',
      { className: 'top' },
      h('div', { className: 'tabs' }, Object.keys(views).map((t) => h('button', { className: 'tab' + (t === tab ? ' active' : ''), textContent: t[0].toUpperCase() + t.slice(1), onclick: () => ((tab = t), draw(repo, id, data, guide)) }))),
      h(
        'div',
        { className: 'acts' },
        pendingCount > 0 && h('button', { className: 'on warn', textContent: `${pendingCount} pending · finish in Bitbucket`, title: 'Pending comments are published when you finish the review in Bitbucket', onclick: () => invoke('open_url', { url: pr.links.html.href }) }),
        h('button', { textContent: 'Open in Bitbucket', onclick: () => invoke('open_url', { url: pr.links.html.href }) }),
        h('button', { className: changes ? 'ask on' : 'ask', textContent: changes ? '● Changes requested' : 'Request changes', onclick: act(changes ? 'remove-request-changes' : 'request-changes') }),
        h('button', { className: mine?.approved ? 'on' : 'primary', textContent: mine?.approved ? '✓ Approved' : 'Approve', onclick: act(mine?.approved ? 'unapprove' : 'approve') }),
      ),
    ),
    h('h1', {}, title),
    // Always visible: who wants to merge what into where.
    h(
      'p',
      { className: 'meta' },
      h('b', { textContent: pr.author?.display_name ?? '?' }),
      ' wants to merge ',
      h('code', { className: 'branch', title: 'Source branch', textContent: pr.source.branch.name }),
      h('span', { className: 'arrow', textContent: '→' }),
      h('code', { className: 'branch', title: 'Target branch', textContent: pr.destination.branch.name }),
      h('span', { className: 'where', textContent: `${repo} #${id}` }),
    ),
    views[tab](),
  );
  // The toolbar may wrap onto several lines; everything that sticks below it follows its real height.
  barWatch.disconnect();
  barWatch.observe(main.querySelector('.top'));
  main.scrollTop = 0;
}

// Sidebar width: drag the grip, double-click resets. Pointer capture keeps the drag alive outside the grip.
const grip = document.getElementById('grip');
const setWidth = (w) => (side.style.width = `${Math.min(Math.max(w, 180), 600)}px`);
setWidth(load('sideWidth', 290));
grip.onpointerdown = (e) => {
  grip.setPointerCapture(e.pointerId);
  grip.onpointermove = (m) => setWidth(m.clientX);
};
grip.onpointerup = () => {
  grip.onpointermove = null;
  save('sideWidth', side.offsetWidth);
};
grip.ondblclick = () => {
  setWidth(290);
  save('sideWidth', 290);
};

// Find in page (Cmd+F): WKWebView has no built-in find bar, so matches are marked with the CSS Custom Highlight API.
// It searches what is rendered: collapsed files and diffs still behind "Show diff" are not included.
const find = { bar: null, ranges: [], i: 0 };
function findRun(query, step = 0) {
  const stale = find.ranges[0] && !find.ranges[0].startContainer.isConnected; // the page was redrawn since the last search
  if (step === 0 || stale) {
    find.ranges = [];
    if (step === 0) find.i = 0;
    // Syntax highlighting splits a line into many text nodes, so search one joined string and map hits back to nodes.
    // A line break is inserted between blocks, so a match never runs from one line into the next.
    const q = query.toLowerCase();
    const nodes = []; // [start offset in text, node]
    let text = '';
    let block = null;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node; q && (node = walker.nextNode()); ) {
      if (node.parentElement.closest('[hidden], textarea')) continue;
      const b = node.parentElement.closest('td, p, li, pre, h1, h2, h3, header, small, .frow, .text, button');
      if (b !== block) text += '\n';
      block = b;
      nodes.push([text.length, node]);
      text += node.data.toLowerCase();
    }
    const locate = (pos) => {
      let lo = 0;
      for (let hi = nodes.length - 1; lo < hi; ) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid][0] <= pos) lo = mid;
        else hi = mid - 1;
      }
      return [nodes[lo][1], pos - nodes[lo][0]];
    };
    for (let at = text.indexOf(q); q && at !== -1 && find.ranges.length < 5000; at = text.indexOf(q, at + q.length)) {
      const r = new Range();
      r.setStart(...locate(at));
      const [endNode, endOffset] = locate(at + q.length - 1); // the node holding the last matched character
      r.setEnd(endNode, endOffset + 1);
      find.ranges.push(r);
    }
  }
  const n = find.ranges.length;
  find.i = n ? (Math.min(find.i, n - 1) + step + n) % n : 0;
  CSS.highlights.set('find', new Highlight(...find.ranges));
  CSS.highlights.set('find-current', new Highlight(...(n ? [find.ranges[find.i]] : [])));
  if (n) find.ranges[find.i].startContainer.parentElement.scrollIntoView({ block: 'center' });
  find.bar.querySelector('small').textContent = !query ? '' : n ? `${find.i + 1} of ${n}${n === 5000 ? '+' : ''}` : 'No matches';
}
function findOpen() {
  if (!find.bar) {
    const input = h('input', { placeholder: 'Find in page', oninput: () => findRun(input.value) });
    const close = () => {
      find.bar.hidden = true;
      CSS.highlights.delete('find');
      CSS.highlights.delete('find-current');
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') findRun(input.value, e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') close();
    };
    find.bar = h('div', { className: 'findbar' }, input, h('small'), h('button', { textContent: '↑', title: 'Previous (Shift+Enter)', onclick: () => findRun(input.value, -1) }), h('button', { textContent: '↓', title: 'Next (Enter)', onclick: () => findRun(input.value, 1) }), h('button', { textContent: '×', title: 'Close (Esc)', onclick: close }));
    document.body.append(find.bar);
  }
  const input = find.bar.querySelector('input');
  find.bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) findRun(input.value);
}
document.addEventListener('keydown', (e) => {
  if (!modKey(e) || document.querySelector('dialog[open]')) return;
  if (e.key === 'f') e.preventDefault(), findOpen();
  else if (e.key === 'g' && find.bar && !find.bar.hidden) e.preventDefault(), findRun(find.bar.querySelector('input').value, e.shiftKey ? -1 : 1);
});

// One dialog for both cases: the setup wizard on first start (cannot be dismissed) and Settings later.
async function openSettings(first) {
  if (document.querySelector('dialog.settings')) return;
  const found = await invoke('installed').catch(() => ({}));
  let pick = agent ?? (found.copilot && !found.claude ? 'copilot' : 'claude');
  let pre = preloadOn();
  let theme = load('theme', 'system');
  const chosen = structuredClone(models);
  const offered = Object.fromEntries(AGENTS.map((x) => [x.id, x.models]));
  const modelNote = h('small');
  // A saved model stays selectable even if the list no longer offers it.
  const modelSelect = (kind) => {
    const value = modelFor(kind, pick, chosen);
    const list = offered[pick].some((m) => m.id === value) ? offered[pick] : [...offered[pick], { id: value, name: value }];
    return h('select', { onchange: (e) => (chosen[pick] = { ...chosen[pick], [kind]: e.target.value }) }, list.map((m) => h('option', { value: m.id, textContent: m.name, selected: m.id === value })));
  };
  const status = h('small');
  const wsInput = h('input', { placeholder: 'e.g. my-company', value: workspaces[0] ?? '' });
  const problem = h('p', { className: 'error' });
  const dlg = h('dialog', { className: 'settings' });
  const test = async () => {
    status.className = '';
    status.textContent = 'Testing, this sends one short request…';
    try {
      const reply = await invoke('agent_test', { agent: pick, model: modelFor('guide', pick, chosen) });
      status.className = 'plus';
      status.textContent = `Works. It replied: ${reply.slice(0, 60)}`;
    } catch (e) {
      status.className = 'minus';
      status.textContent = String(e).slice(0, 300);
    }
  };
  const done = () => {
    const ws = wsInput.value.trim();
    if (first && !/^[\w.-]+$/.test(ws)) return (problem.textContent = 'Enter your Bitbucket workspace, the first part of the URL after bitbucket.org/.');
    if (first && !workspaces.includes(ws)) workspaces = [ws, ...workspaces];
    // Results belong to the agent and model that wrote them.
    if (pick !== agent || ['guide', 'tour'].some((kind) => modelFor(kind, pick, chosen) !== modelFor(kind, pick))) for (const m of [guides, guideDone, tours, tourDone, streamed]) m.clear();
    agent = pick;
    models = chosen;
    save('agent', agent);
    save('models', models);
    save('preload', pre);
    save('theme', theme);
    applyTheme(theme);
    save('workspaces', workspaces);
    dlg.close();
    dlg.remove();
    renderSide();
    refresh();
    if (current) select(current.slice(0, current.lastIndexOf('#')), +current.slice(current.lastIndexOf('#') + 1));
  };
  const render = () =>
    set(
      dlg,
      h('h2', { textContent: first ? 'Welcome to Better Review' : 'Settings' }),
      first && h('p', { className: 'muted', textContent: 'Two choices and you are ready to review.' }),
      h('h3', { textContent: 'AI agent' }),
      h('p', { className: 'muted', textContent: 'Writes the review guide and the tour. It runs through a CLI on this Mac, with your own account.' }),
      AGENTS.map((x) =>
        h(
          'label',
          { className: 'option' + (pick === x.id ? ' on' : '') },
          h('input', {
            type: 'radio',
            name: 'agent',
            checked: pick === x.id,
            onchange: () => {
              pick = x.id;
              status.textContent = '';
              render();
            },
          }),
          h('div', {}, h('b', { textContent: x.name }), h('small', { textContent: x.note }), h('small', { className: found[x.id] ? 'plus' : 'minus', textContent: found[x.id] ? 'Installed' : `Not found. ${x.install}` })),
        ),
      ),
      h('div', { className: 'models' }, h('label', {}, 'Guide model', modelSelect('guide')), h('label', {}, 'Tour model', modelSelect('tour'))),
      modelNote,
      h('div', { className: 'row' }, h('button', { type: 'button', textContent: 'Test this agent', onclick: test }), status),
      h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: pre, onchange: (e) => (pre = e.target.checked) }), 'Prepare guides for all pull requests in the background'),
      h('small', { textContent: 'One AI request per open pull request. If off, a guide is written when you open the pull request.' }),
      h('h3', { textContent: 'Appearance' }),
      h('div', { className: 'models' }, h('label', {}, 'Theme', h('select', { onchange: (e) => (theme = e.target.value) }, [['system', 'Same as system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, textContent]) => h('option', { value, textContent, selected: value === theme }))))),
      first && [h('h3', { textContent: 'Bitbucket workspace' }), wsInput, found.twg === false && h('p', { className: 'error', textContent: 'The twg CLI was not found. Better Review needs it to read Bitbucket.' })],
      problem,
      h('div', { className: 'row end' }, !first && h('button', { type: 'button', textContent: 'Cancel', onclick: () => (dlg.close(), dlg.remove()) }), h('button', { type: 'button', className: 'primary', textContent: first ? 'Start reviewing' : 'Save', onclick: done })),
    );
  dlg.addEventListener('cancel', (e) => (first ? e.preventDefault() : dlg.remove()));
  render();
  if (found.copilot) {
    invoke('models')
      .then((list) => {
        offered.copilot = [...AGENTS.find((x) => x.id === 'copilot').models, ...list];
        if (!list.length) modelNote.textContent = 'Copilot: your plan offers no models to pick from, only Auto.';
      })
      .catch((e) => (modelNote.textContent = `Could not read Copilot's models: ${String(e).slice(0, 200)}`))
      .then(render);
  }
  document.body.append(dlg);
  dlg.showModal();
}
window.__TAURI__.event?.listen('open-settings', () => openSettings(!agent));

renderSide();
if (agent) refresh();
else openSettings(true);
