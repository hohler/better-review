// ponytail: path heuristic, the LLM catches the rest. Tune the patterns here on false hits.
export const GENERATED = new RegExp(
  [
    '(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|Cargo\\.lock|composer\\.lock|Gemfile\\.lock|poetry\\.lock|uv\\.lock|Podfile\\.lock|pubspec\\.lock|go\\.sum)$',
    '(^|/)(dist|vendor|node_modules|generated|__generated__|__snapshots__|\\.next)/',
    '\\.(min\\.(js|css)|map|snap|g\\.dart|freezed\\.dart|pb\\.go|generated\\.\\w+|gen\\.\\w+)$',
    '_pb2?\\.py$',
  ].join('|'),
);

// Test files stay in their guide group, but their diff starts collapsed.
export const TEST = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\/|\.(test|spec|e2e|cy)\.\w+$|_test\.(go|py|dart|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|swift|cs|php)$/;

export function parseDiff(text) {
  const files = [];
  let f = null, h = null, o = 0, n = 0, oldLeft = 0, newLeft = 0;
  for (const line of text.split('\n')) {
    // Inside a hunk only the header's line counts decide, otherwise a removed "-- a/x" line reads as a file header.
    if (h && (oldLeft > 0 || newLeft > 0)) {
      const t = line[0];
      if (t === '\\') continue;
      if (t === '+') { h.lines.push({ t, n: n++, text: line.slice(1) }); newLeft--; f.added++; }
      else if (t === '-') { h.lines.push({ t, o: o++, text: line.slice(1) }); oldLeft--; f.removed++; }
      else { h.lines.push({ t: ' ', o: o++, n: n++, text: line.slice(1) }); oldLeft--; newLeft--; }
      continue;
    }
    let m;
    if ((m = /^diff --git a\/(.*) b\/(.*)$/.exec(line))) {
      f = { path: m[2], oldPath: m[1], status: 'modified', binary: false, added: 0, removed: 0, hunks: [] };
      files.push(f);
      h = null;
    } else if (!f) continue;
    else if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) { f.status = 'renamed'; f.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('--- a/')) f.oldPath = line.slice(6);
    else if (line.startsWith('+++ b/')) f.path = line.slice(6);
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true;
    else if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line))) {
      o = +m[1]; oldLeft = m[2] === undefined ? 1 : +m[2];
      n = +m[3]; newLeft = m[4] === undefined ? 1 : +m[4];
      h = { header: line, start: n, count: newLeft, lines: [] };
      f.hunks.push(h);
    }
  }
  return files;
}

// Guarantees: every file exactly once, generated files never in a group, invented paths dropped.
export function normalizeGuide(raw, files) {
  const known = new Set(files.map((f) => f.path));
  const generated = files.map((f) => f.path).filter((p) => GENERATED.test(p) || raw?.generated?.includes(p));
  const seen = new Set(generated);
  const groups = [];
  for (const g of raw?.groups ?? []) {
    const paths = (g.files ?? []).filter((p) => known.has(p) && !seen.has(p) && seen.add(p));
    if (paths.length) groups.push({ title: g.title, summary: g.summary, files: paths });
  }
  const rest = [...known].filter((p) => !seen.has(p));
  if (rest.length) groups.push({ title: groups.length ? 'Other changes' : 'Changes', summary: '', files: rest });
  return { summary: raw?.summary ?? '', groups, generated };
}

// ponytail: hard truncation (400 lines per file, 150k chars total). For huge PRs summarize per group instead.
export function guideInput(pr, files, max = 150000) {
  let out = `Title: ${pr.title}\n\nDescription:\n${pr.description || '-'}\n\nFiles:\n`;
  out += files.map((f) => `${f.path} (${f.status}, +${f.added} -${f.removed})${GENERATED.test(f.path) ? ' [generated]' : ''}`).join('\n');
  out += '\n\nDiff:\n';
  for (const f of files) {
    if (GENERATED.test(f.path) || f.binary) continue;
    const body = f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.t + l.text)]).slice(0, 400).join('\n');
    const chunk = `--- ${f.path}\n${body}\n`;
    out += out.length + chunk.length > max ? `--- ${f.path}\n(truncated)\n` : chunk;
  }
  return out;
}

// Markdown for descriptions and comments, parsed to plain data: the interface builds DOM nodes from it, never HTML.
// Covers what PR text uses: headings, lists (nested, tasks), quotes, fenced code, tables, rules, emphasis, code and links.
// ponytail: no setext headings, HTML or reference links; they show as the text that was typed.
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const INLINE = /(`+)(.+?)\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>]+)|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|~~(.+?)~~|\*(?!\s)(.+?)(?<!\s)\*|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|\\([\\`*_{}[\]()#+\-.!|>~])/gs;

export function inline(text) {
  const out = [];
  const push = (s) => s && (out.at(-1)?.t === 'text' ? (out.at(-1).text += s) : out.push({ t: 'text', text: s }));
  // Only web links become links: anything else (javascript:, file:) stays visible as text.
  const link = (href, kids, whole) => (/^https:\/\//i.test(href) ? out.push({ t: 'link', href, kids }) : push(whole));
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] != null) out.push({ t: 'code', text: m[2].trim() || m[2] });
    else if (m[4] != null) link(m[4], [{ t: 'text', text: m[3] || 'image' }], m[0]);
    else if (m[6] != null) link(m[6], inline(m[5]), m[0]);
    else if (m[7] != null) link(m[7], [{ t: 'text', text: m[7] }], m[0]);
    else if (m[8] != null) {
      // Punctuation after a bare URL belongs to the sentence, not the link.
      const href = m[8].replace(/[.,;:!?)\]'"]+$/, '');
      link(href, [{ t: 'text', text: href }], href);
      push(m[8].slice(href.length));
    } else if (m[14] != null) push(m[14]);
    else out.push({ t: m[9] != null || m[10] != null ? 'b' : m[11] != null ? 's' : 'i', kids: inline(m[9] ?? m[10] ?? m[11] ?? m[12] ?? m[13]) });
  }
  push(text.slice(last));
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
const dedent = (lines) => {
  const n = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(n) ? n : 0));
};

function blocks(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ type: 'p', inline: inline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    let m;
    if ((m = FENCE.exec(line))) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) body.push(lines[i]);
      i++;
      out.push({ type: 'code', lang: m[2], text: body.join('\n') });
    } else if (!line.trim()) {
      flush();
      i++;
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out.push({ type: 'h', level: m[1].length, inline: inline(m[2]) });
      i++;
    } else if (RULE.test(line)) {
      flush();
      out.push({ type: 'hr' });
      i++;
    } else if (/^\s*>/.test(line)) {
      flush();
      const quoted = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push({ type: 'quote', blocks: blocks(quoted) });
    } else if (ITEM.test(line)) {
      flush();
      const [, indent, marker] = ITEM.exec(line);
      const ordered = /\d/.test(marker);
      const items = [];
      while (i < lines.length && (m = ITEM.exec(lines[i])) && m[1].length === indent.length && /\d/.test(m[2]) === ordered) {
        const text = [m[3]];
        const kids = [];
        // Deeper-indented lines belong to this item (nested list, code, second paragraph); a plain next line continues its text.
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          const deeper = l.match(/^\s*/)[0].length > indent.length;
          if (!l.trim()) {
            const next = lines.slice(i + 1).find((x) => x.trim());
            if (!next || next.match(/^\s*/)[0].length <= indent.length) break;
            kids.push('');
          } else if (deeper && (kids.length || ITEM.test(l) || FENCE.test(l))) kids.push(l);
          else if (deeper || !(ITEM.test(l) || RULE.test(l) || FENCE.test(l) || /^\s*(>|#{1,6}\s)/.test(l))) text.push(l.trim());
          else break;
        }
        const task = /^\[([ xX])\]\s+(.*)$/s.exec(text.join('\n'));
        items.push({ inline: inline(task ? task[2] : text.join('\n')), ...(task && { checked: task[1] !== ' ' }), blocks: blocks(dedent(kids)) });
        while (i < lines.length && !lines[i].trim() && ITEM.test(lines.slice(i + 1).find((x) => x.trim()) ?? '')) i++;
      }
      out.push({ type: ordered ? 'ol' : 'ul', items });
    } else if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push({ type: 'table', head, rows });
    } else {
      para.push(line);
      i++;
    }
  }
  flush();
  return out;
}

export const markdown = (raw) => blocks((raw ?? '').replace(/\r\n?/g, '\n').split('\n'));

// Tokens for showing markdown formatted inside the text field itself. Every character of the input is kept, in order,
// so the styled copy lines up with what is typed. Classes: mk marker, b, i, s, c code, a link text, u url, h heading,
// q quote, li list marker, task, fence, cb code block line (with lang).
export function mdTokens(text) {
  const out = [];
  const push = (t, cls = '', extra) => t && out.push({ text: t, cls, ...extra });
  const spans = (line) => {
    let last = 0;
    for (const m of line.matchAll(INLINE)) {
      push(line.slice(last, m.index));
      last = m.index + m[0].length;
      const around = (n, cls) => (push(m[0].slice(0, n), 'mk'), push(m[0].slice(n, -n), cls), push(m[0].slice(-n), 'mk'));
      if (m[2] != null) around(m[1].length, 'c');
      else if (m[4] != null || m[6] != null) {
        const open = m[4] != null ? '![' : '[';
        const label = m[4] != null ? m[3] : m[5];
        push(open, 'mk'), push(label, 'a'), push('](', 'mk'), push(m[0].slice(open.length + label.length + 2, -1), 'u'), push(')', 'mk');
      } else if (m[7] != null) around(1, 'a');
      else if (m[8] != null) push(m[0], 'a');
      else if (m[14] != null) push('\\', 'mk'), push(m[14]);
      else if (m[9] != null || m[10] != null) around(2, 'b');
      else if (m[11] != null) around(2, 's');
      else around(1, 'i');
    }
    push(line.slice(last));
  };
  let fence = null;
  text.split('\n').forEach((line, n) => {
    if (n) push('\n');
    let m;
    if (fence) {
      if (line.trim().startsWith(fence.mark)) (push(line, 'fence'), (fence = null));
      else push(line, 'cb', { lang: fence.lang });
    } else if ((m = FENCE.exec(line))) (push(line, 'fence'), (fence = { mark: m[1], lang: m[2] }));
    else if ((m = /^(\s{0,3}#{1,6}\s+)(.*)$/.exec(line))) push(m[1], 'mk'), push(m[2], 'h');
    else if (RULE.test(line)) push(line, 'mk');
    else if ((m = /^(\s*>\s?)(.*)$/.exec(line))) push(m[1], 'mk'), push(m[2], 'q');
    else if ((m = /^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line))) push(m[1], 'li'), push(m[2], 'task'), spans(m[3]);
    else spans(line);
  });
  return out;
}

// Editing helpers for the markdown comment field. Each takes the text and selection and returns one edit:
// replace [from, to) with text, then select [start, end). They return null when they do not apply.
const lineSpan = (v, s, e) => [v.lastIndexOf('\n', s - 1) + 1, v.indexOf('\n', e) < 0 ? v.length : v.indexOf('\n', e)];
const inFence = (v, s) => (v.slice(0, s).match(/^\s*```/gm)?.length ?? 0) % 2 === 1;
const LIST_LINE = /^\s*([-*+]|\d+[.)])\s/;

// Bold, italic, code: wraps the selection or a placeholder. On text that is already wrapped it removes the wrapping.
export function mdWrap(v, s, e, before, after = before, placeholder = 'text') {
  const sel = v.slice(s, e);
  if (s >= before.length && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) return { from: s - before.length, to: e + after.length, text: sel, start: s - before.length, end: e - before.length };
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { from: s, to: e, text: inner, start: s, end: s + inner.length };
  }
  const text = sel || placeholder;
  return { from: s, to: e, text: before + text + after, start: s + before.length, end: s + before.length + text.length };
}

// Lists, tasks and quotes: puts the marker on every selected line, or takes it off if all of them have it.
export function mdPrefix(v, s, e, kind) {
  const [from, to] = lineSpan(v, s, e > s && v[e - 1] === '\n' ? e - 1 : e);
  const lines = v.slice(from, to).split('\n');
  const has = { ul: /^\s*[-*+]\s+(?!\[[ xX]\])/, ol: /^\s*\d+[.)]\s+/, task: /^\s*[-*+]\s+\[[ xX]\]\s+/, quote: /^\s*>/ }[kind];
  const mark = (i) => ({ ul: '- ', ol: `${i + 1}. `, task: '- [ ] ', quote: '> ' })[kind];
  const strip = (l) => l.replace(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '$1');
  const on = lines.every((l) => has.test(l));
  const text = lines.map((l, i) => (on ? strip(l) : strip(l).replace(/^(\s*)/, `$1${mark(i)}`))).join('\n');
  return { from, to, text, start: s === e ? from + text.length : from, end: from + text.length };
}

// Enter in a list continues it with the next marker. Enter on an empty item ends the list.
export function mdEnter(v, s, e) {
  if (s !== e || inFence(v, s)) return null;
  const from = v.lastIndexOf('\n', s - 1) + 1;
  const m = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/.exec(v.slice(from, s));
  if (!m) return null;
  if (!m[6].trim()) return { from, to: s, text: '', start: from, end: from };
  const next = `\n${m[1]}${m[2] ?? `${+m[3] + 1}${m[4]}`} ${m[5] ? '[ ] ' : ''}`;
  return { from: s, to: s, text: next, start: s + next.length, end: s + next.length };
}

// Tab and Shift+Tab: nests or un-nests list items; inside a code block Tab types two spaces.
export function mdIndent(v, s, e, out) {
  if (inFence(v, s)) return out ? null : { from: s, to: e, text: '  ', start: s + 2, end: s + 2 };
  const [from, to] = lineSpan(v, s, e);
  const lines = v.slice(from, to).split('\n');
  if (!lines.every((l) => LIST_LINE.test(l))) return null;
  const text = lines.map((l) => (out ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
  const first = text.split('\n')[0].length - lines[0].length;
  return { from, to, text, start: Math.max(from, s + first), end: Math.max(from, e + text.length - (to - from)) };
}

// A link around the selection. Without a URL the placeholder URL stays selected, ready to be typed over.
export function mdLink(v, s, e, url) {
  const label = v.slice(s, e) || 'text';
  const text = `[${label}](${url ?? 'https://'})`;
  return url ? { from: s, to: e, text, start: s + text.length, end: s + text.length } : { from: s, to: e, text, start: s + label.length + 3, end: s + text.length - 1 };
}

// A fenced code block on its own lines, around the selection or the given code.
export function mdBlock(v, s, e, lang = '', code) {
  const body = code ?? (v.slice(s, e) || 'code');
  const lead = s > 0 && v[s - 1] !== '\n' ? '\n' : '';
  const open = `${lead}\`\`\`${lang}\n`;
  return { from: s, to: e, text: `${open}${body}\n\`\`\`\n`, start: s + open.length, end: s + open.length + body.length };
}

// Symbols defined inside the PR's diff, so a use can link to its definition. Found by pattern, not by parsing:
// functions, classes and types in the common languages, exported constants, and local constants holding a function.
// ponytail: class methods and anything defined outside the shown hunks are not found; a language server would be the upgrade.
const NAME = '([A-Za-z_$][\\w$]*)';
const DEFS = [
  [new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*${NAME}\\s*[(<]`), false],
  [new RegExp(`\\b(?:class|interface|enum|struct|trait|type)\\s+${NAME}`), false],
  [new RegExp(`\\b(?:def|fn|fun|func)\\s+(?:\\([^)]*\\)\\s*)?${NAME}\\s*[(<]`), false],
  [new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${NAME}`), false],
  // A local constant holding a function is only linked inside its own file: names like "handle" repeat across files.
  [new RegExp(`\\b(?:const|let|var)\\s+${NAME}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\(|[\\w$]+\\s*=>|<)`), true],
];
export function symbolIndex(files) {
  const defs = new Map();
  for (const f of files) {
    if (GENERATED.test(f.path)) continue;
    for (const hunk of f.hunks) {
      for (const l of hunk.lines) {
        if (l.t === '-' || l.n == null) continue;
        const hit = DEFS.map(([re, local]) => [re.exec(l.text), local]).find(([m]) => m);
        if (!hit || hit[0][1].length < 3) continue;
        const list = defs.get(hit[0][1]) ?? defs.set(hit[0][1], []).get(hit[0][1]);
        list.push({ path: f.path, line: l.n, local: hit[1] });
      }
    }
  }
  const names = [...defs.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/\$/g, '\\$'));
  // Not after a dot: obj.save() is a method, not the function save defined in this PR.
  return { defs, pattern: names.length ? new RegExp(`(?<![.\\w$])(?:${names.join('|')})(?![\\w$])`, 'g') : null };
}
// Where a use of name at path:line leads: a definition in the same file first, else one elsewhere. Never to itself.
export function symbolTarget(index, name, path, line) {
  const list = (index.defs.get(name) ?? []).filter((d) => !(d.path === path && d.line === line));
  return list.find((d) => d.path === path) ?? list.find((d) => !d.local) ?? null;
}

// The lines to show for a definition at file:line: a comment directly above it, then the body by indentation,
// until a line is no deeper than the definition (a closing brace is kept). Stops at the hunk's end or after max lines.
export function defSnippet(file, line, max = 15) {
  for (const hunk of file.hunks) {
    const lines = hunk.lines.filter((l) => l.t !== '-' && l.n != null);
    const at = lines.findIndex((l) => l.n === line);
    if (at < 0) continue;
    const indent = (l) => l.text.match(/^\s*/)[0].length;
    const base = indent(lines[at]);
    let from = at;
    while (from > 0 && /^\s*(\/\/|\/\*|\*|#)/.test(lines[from - 1].text)) from--;
    let to = at + 1;
    for (; to < lines.length; to++) {
      const l = lines[to];
      if (l.text.trim() && indent(l) <= base) {
        if (/^\s*[)}\]]|^\s*end\b/.test(l.text)) to++;
        break;
      }
    }
    while (to > at + 1 && !lines[to - 1].text.trim()) to--;
    return { lines: lines.slice(from, Math.min(to, from + max)), more: to - from > max };
  }
  return null;
}

// Tour: every hunk of a regular source file gets an id (H1, H2, ...) that the LLM uses to build its stops.
const isCore = (f) => !GENERATED.test(f.path) && !TEST.test(f.path);
export function tourHunks(files) {
  let n = 0;
  return files.filter(isCore).flatMap((f) => f.hunks.map((hunk) => ({ id: `H${++n}`, path: f.path, hunk })));
}

export function tourInput(pr, files, max = 150000) {
  const tests = files.filter((f) => TEST.test(f.path) && !GENERATED.test(f.path)).map((f) => f.path);
  let out = `Title: ${pr.title}\n\nDescription:\n${pr.description || '-'}\n\nChanged test files (content not shown):\n${tests.join('\n') || '-'}\n\nHunks:\n`;
  let path = null;
  for (const { id, path: p, hunk } of tourHunks(files)) {
    const chunk = `${p !== path ? `\n### ${p}\n` : ''}${id} ${hunk.header}\n${hunk.lines.map((l) => l.t + l.text).join('\n')}\n`;
    // ponytail: hunks past the size cap are not sent, the coverage check then puts them in "Not covered by the tour".
    if (out.length + chunk.length > max) break;
    out += chunk;
    path = p;
  }
  return out;
}

// Coverage guarantee: every hunk and every file ends up in exactly one stop, whatever the LLM returned.
export function normalizeTour(raw, files) {
  const all = tourHunks(files);
  const byId = new Map(all.map((h) => [h.id, h]));
  const seen = new Set();
  const parts = (hs) => {
    const m = new Map();
    for (const h of hs) m.set(h.path, [...(m.get(h.path) ?? []), h.hunk]);
    return [...m].map(([path, hunks]) => ({ path, hunks: hunks.sort((a, b) => a.start - b.start) }));
  };
  const stops = [];
  for (const s of raw?.stops ?? []) {
    const hs = (s.hunks ?? []).map((id) => byId.get(id)).filter((h) => h && !seen.has(h.id) && seen.add(h.id));
    if (hs.length) stops.push({ title: s.title, explanation: s.explanation ?? '', check: s.check ?? '', parts: parts(hs), files: [] });
  }
  const missed = all.filter((h) => !seen.has(h.id));
  const bare = files.filter((f) => isCore(f) && !f.hunks.length).map((f) => f.path); // binary or rename-only
  if (missed.length || bare.length) stops.push({ title: 'Not covered by the tour', explanation: 'These changes were not placed in a stop. Review them here so nothing is skipped.', check: '', parts: parts(missed), files: bare });
  const tests = files.filter((f) => TEST.test(f.path) && !GENERATED.test(f.path)).map((f) => f.path);
  if (tests.length) stops.push({ title: 'Tests', explanation: raw?.tests || 'The test files changed in this pull request.', check: '', parts: [], files: tests });
  const generated = files.filter((f) => GENERATED.test(f.path)).map((f) => f.path);
  if (generated.length) stops.push({ title: 'Generated files', explanation: 'Machine generated. A glance is usually enough.', check: '', parts: [], files: generated });
  return { briefing: raw?.briefing ?? '', stops, questions: raw?.questions ?? [] };
}
