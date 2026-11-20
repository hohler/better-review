import { TEST, segments, parseDiff, normalizeGuide, guideInput } from './lib.js';

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
const rich = (raw, className = 'text') =>
  h('div', { className }, segments(raw ?? '').map((s) => (s.type === 'block' ? h('pre', {}, highlight(h('code'), s.text, s.lang)) : s.type === 'code' ? h('code', { textContent: s.text }) : s.text)));
const key = (repo, id) => `${repo}#${id}`;

let workspaces = load('workspaces', ['entwicklungspark']);
let inboxes = load('inboxes', {});
const errors = {};
let current = null;
const prs = new Map(); // key -> Promise<{pr, files}>
const guides = new Map(); // key -> Promise<guide>
const guideDone = new Map(); // key -> guide
let tab = 'guide';

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
      const raw = await invoke('guide', { key: `${repo}-${id}-${pr.source.commit.hash}`, input: guideInput(pr, files) });
      const guide = normalizeGuide(JSON.parse(raw), files);
      guideDone.set(k, guide);
      return guide;
    });
    p.catch(() => guides.delete(k));
    guides.set(k, p);
  }
  return guides.get(k);
}

async function refresh() {
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
  // ponytail: guides preload one at a time, raise to 2-3 in parallel if the queue gets long.
  for (const ws of workspaces) for (const i of inboxes[ws]?.items ?? []) await loadGuide(i.repo, i.id).catch(() => {});
}

function renderSide() {
  set(side, 
    h('header', {}, h('strong', { textContent: 'Reviews' }), h('button', { textContent: '↻', title: 'Refresh', onclick: refresh })),
    workspaces.map((ws) => {
      const items = inboxes[ws]?.items ?? [];
      const remove = () => {
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
          list
            .sort((a, b) => b.updatedOn.localeCompare(a.updatedOn))
            .map((i) =>
              h(
                'a',
                { className: 'pr' + (current === key(i.repo, i.id) ? ' active' : ''), onclick: () => select(i.repo, i.id) },
                h('span', { textContent: `${i.attention?.approved ? '✓ ' : ''}${i.title}` }),
                i.attention?.participantState === 'changes_requested' && h('small', { className: 'warn', textContent: '● Changes requested' }),
                h('small', { textContent: `${i.repo.split('/')[1]} #${i.id} · ${i.author?.displayName ?? '?'} · ${ago(i.updatedOn)}` }),
              ),
            ),
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
  if (!keepScroll) set(main, h('p', { className: 'muted', textContent: 'Loading…' }));
  try {
    const data = await loadPr(repo, id);
    if (current !== k) return;
    draw(repo, id, data, guideDone.get(k));
    if (keepScroll) main.scrollTop = y;
    if (guideDone.has(k)) return;
    const box = main.querySelector('.guide');
    const show = () => current === k && draw(repo, id, data, guideDone.get(k));
    loadGuide(repo, id).then(
      () => {
        if (current !== k || !box.isConnected) return;
        // Do not reorder the page while the user is already reading or writing.
        if (main.scrollTop < 300 && !main.querySelector('form.comment')) show();
        else set(box, h('button', { className: 'primary', textContent: 'Review guide is ready, show it', onclick: show }));
      },
      (e) => box.isConnected && set(box, h('p', { className: 'error', textContent: `Guide failed: ${e}` })),
    );
  } catch (e) {
    if (current === k) set(main, h('p', { className: 'error', textContent: String(e) }));
  }
}

// After a write, reload the PR; guide and scroll position stay.
function reload(repo, id) {
  prs.delete(key(repo, id));
  return select(repo, id, true);
}

function commentForm(send, onCancel) {
  const area = h('textarea', { placeholder: 'Comment (Cmd+Enter to send)' });
  const err = h('p', { className: 'error' });
  const btn = h('button', { className: 'primary', textContent: 'Comment' });
  const form = h('form', { className: 'comment' }, area, h('div', {}, btn, onCancel && h('button', { type: 'button', textContent: 'Cancel', onclick: onCancel })), err);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!area.value.trim()) return;
    btn.disabled = true;
    try {
      await send(area.value);
    } catch (ex) {
      err.textContent = String(ex);
      btn.disabled = false;
    }
  };
  area.onkeydown = (e) => {
    if (e.metaKey && e.key === 'Enter') form.requestSubmit();
  };
  setTimeout(() => onCancel && area.focus());
  return form;
}

function threadEl(root, comments, post) {
  const ids = new Set([root.id]);
  const all = [root];
  for (const c of comments) if (c.parent && ids.has(c.parent.id)) ids.add(c.id), all.push(c); // comments arrive in chronological order
  const slot = h('div');
  const reply = h('button', {
    textContent: 'Reply',
    onclick: () => set(slot, commentForm((text) => post({ text, replyTo: root.id }), () => set(slot, reply))),
  });
  slot.append(reply);
  return h(
    'div',
    { className: 'thread' + (root.resolution ? ' resolved' : '') },
    all.map((c) => h('div', { className: 'comment' }, h('b', { textContent: c.user?.display_name ?? '?' }), h('small', { textContent: ` ${ago(c.created_on)}${c === root && root.resolution ? ' · resolved' : ''}` }), rich(c.content?.raw))),
    slot,
  );
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
function fileEl(f, hidden, ctx) {
  const { comments, post, reviewed, toggle } = ctx;
  const roots = comments.filter((c) => !c.parent && c.inline?.path === f.path);
  const [name, dir] = split(f.path);
  const done = reviewed.has(f.path);
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
      check(done, () => toggle([f.path], !done, !done && card.getBoundingClientRect().top < main.getBoundingClientRect().top && card.id)),
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
    let end = 0; // last new-side line of the previous hunk
    for (const hunk of f.hunks) {
      const gap = hunk.start - end - 1;
      if (gap > 0) tbody.append(h('tr', { className: 'gap' }, h('td', { colSpan: 2, textContent: `↕ ${gap} unchanged line${gap > 1 ? 's' : ''}` })));
      end = hunk.start + hunk.count - 1;
      for (const l of hunk.lines) {
        const row = h('tr', { className: l.t === '+' ? 'add' : l.t === '-' ? 'del' : '' });
        const anchor = l.t === '-' ? { fromLine: l.o } : { line: l.n };
        const start = () => {
          if (row.nextSibling?.dataset.form) return row.nextSibling.remove();
          const tr = note(commentForm((text) => post({ text, path: f.path, ...anchor }), () => tr.remove()));
          tr.dataset.form = '1';
          row.after(tr);
        };
        const code = highlight(h('td', { className: 'code' }), l.text, lang);
        row.append(h('td', { className: 'no', textContent: l.n ?? '−', title: 'Comment on this line', onclick: start }), code);
        tbody.append(row);
        const here = roots.filter((c) => !placed.has(c) && (c.inline.to != null ? l.n === c.inline.to : l.t !== '+' && l.o === c.inline.from));
        if (here.length) tbody.append(note(here.map((c) => (placed.add(c), threadEl(c, comments, post)))));
      }
    }
    const outdated = roots.filter((c) => !placed.has(c));
    if (outdated.length) tbody.prepend(note(h('small', { textContent: 'Comments outside the current diff' }), outdated.map((c) => threadEl(c, comments, post))));
    set(body, h('div', { className: 'scroll' }, h('table', { className: 'diff' }, tbody)));
  };
  card.show = show;
  if (done) body.hidden = true;
  else if (hidden) set(body, h('div', { className: 'placeholder' }, h('p', { textContent: `${hidden} are not shown by default` }), h('button', { textContent: 'Show diff', onclick: show })));
  else show();
  return card;
}

function draw(repo, id, data, guide) {
  const { pr, files } = data;
  const g = guide ?? normalizeGuide(null, files);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  const comments = (pr._comments ?? []).filter((c) => !c.deleted);
  const general = comments.filter((c) => !c.parent && !c.inline);
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
  const post = async (args) => {
    await invoke('comment', { repo, id, ...args });
    await reload(repo, id);
  };
  const act = (action) => async (e) => {
    e.target.disabled = true;
    try {
      await invoke('review', { repo, id, action });
      await reload(repo, id);
    } catch (ex) {
      e.target.disabled = false;
      alert(ex);
    }
  };
  const ctx = { comments, post, reviewed, toggle };
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
  const views = {
    overview: () => [
      guide && rich(g.summary, 'lead text'),
      pr.description && h('div', { className: 'box' }, h('h3', { textContent: 'Description' }), rich(pr.description)),
      h('div', { className: 'box' }, h('h3', { textContent: `Discussion (${general.length})` }), general.map((c) => threadEl(c, comments, post)), commentForm((text) => post({ text }))),
    ],
    guide: () => steps.map(step),
    diff: () => h('div', { className: 'cards' }, files.map((f) => card(f.path))),
  };

  set(
    main,
    h(
      'div',
      { className: 'top' },
      Object.keys(views).map((t) => h('button', { className: 'tab' + (t === tab ? ' active' : ''), textContent: t[0].toUpperCase() + t.slice(1), onclick: () => ((tab = t), draw(repo, id, data, guide)) })),
      h('span', { className: 'grow' }),
      h('button', { textContent: 'Open in Bitbucket', onclick: () => invoke('open_url', { url: pr.links.html.href }) }),
      h('button', { className: changes ? 'on warn' : '', textContent: changes ? '✗ Changes requested' : 'Request changes', onclick: act(changes ? 'remove-request-changes' : 'request-changes') }),
      h('button', { className: mine?.approved ? 'on' : 'primary', textContent: mine?.approved ? '✓ Approved' : 'Approve', onclick: act(mine?.approved ? 'unapprove' : 'approve') }),
    ),
    h('h1', { textContent: pr.title }),
    h('p', { className: 'meta' }, h('span', { textContent: `${pr.author?.display_name ?? '?'} · ` }), h('code', { textContent: `${pr.destination.branch.name} ← ${pr.source.branch.name}` }), h('span', { textContent: ` · ${repo} #${id} · ${files.length} files · ${reviewed.size} reviewed · updated ${ago(pr.updated_on)}` })),
    !guide && h('div', { className: 'guide' }, h('p', { className: 'muted', textContent: 'Generating review guide…' })),
    views[tab](),
  );
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

renderSide();
refresh();
