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

// Minimal Markdown for comments: fenced blocks (```tsx) and inline `code`; everything else stays plain text.
export function segments(raw) {
  const out = [];
  const inline = (s) => s.split(/`([^`\n]+)`/).forEach((t, i) => t && out.push({ type: i % 2 ? 'code' : 'text', text: t }));
  let last = 0;
  for (const m of raw.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)\n?```/g)) {
    inline(raw.slice(last, m.index).replace(/\n$/, ''));
    out.push({ type: 'block', lang: m[1], text: m[2] });
    last = m.index + m[0].length;
  }
  inline(raw.slice(last).replace(/^\n/, ''));
  return out;
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
