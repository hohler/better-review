import assert from 'node:assert/strict';
import { GENERATED, TEST, segments, tourHunks, tourInput, normalizeTour, parseDiff, normalizeGuide, guideInput } from './ui/lib.js';

const diff = `✓ Workspace loaded.
diff --git a/src/a.ts b/src/a.ts
index 02bed14c..784e05be 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,4 @@ function x() {
 keep
--- a/looks-like-header
+++ b/looks-like-header

 tail
\\ No newline at end of file
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
new file mode 100644
--- /dev/null
+++ b/pnpm-lock.yaml
@@ -0,0 +1 @@
+lock
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

const files = parseDiff(diff);
assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.removed]), [
  ['src/a.ts', 'modified', 1, 1],
  ['new.ts', 'renamed', 0, 0],
  ['pnpm-lock.yaml', 'added', 1, 0],
  ['logo.png', 'modified', 0, 0],
]);
assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.t, l.o, l.n, l.text]), [
  [' ', 10, 10, 'keep'],
  ['-', 11, undefined, '-- a/looks-like-header'],
  ['+', undefined, 11, '++ b/looks-like-header'],
  [' ', 12, 12, ''],
  [' ', 13, 13, 'tail'],
]);
assert.equal(files[1].oldPath, 'old.ts');
assert.equal(files[3].binary, true);

for (const p of ['pnpm-lock.yaml', 'a/b/package-lock.json', 'web/dist/app.js', 'x.min.js', 'lib/model.g.dart', 'src/__snapshots__/a.snap']) assert.ok(GENERATED.test(p), p);
for (const p of ['src/a.ts', 'src/generator.ts', 'distribution/a.ts', 'package.json']) assert.ok(!GENERATED.test(p), p);

for (const p of ['src/a.test.ts', 'app/__tests__/a.ts', 'pkg/a_test.go', 'tests/test_a.py', 'e2e/login.ts', 'src/FooTest.kt', 'a.spec.tsx']) assert.ok(TEST.test(p), p);
for (const p of ['src/a.ts', 'src/testing-utils.ts', 'src/contest/a.ts', 'latest.ts']) assert.ok(!TEST.test(p), p);

const guide = normalizeGuide(
  { summary: 's', groups: [{ title: 'Kern', summary: 'k', files: ['src/a.ts', 'erfunden.ts', 'pnpm-lock.yaml'] }, { title: 'Doppelt', summary: '', files: ['src/a.ts'] }], generated: ['logo.png'] },
  files,
);
assert.deepEqual(guide.groups, [
  { title: 'Kern', summary: 'k', files: ['src/a.ts'] },
  { title: 'Other changes', summary: '', files: ['new.ts'] },
]);
assert.deepEqual(guide.generated, ['pnpm-lock.yaml', 'logo.png']);
assert.deepEqual(normalizeGuide(null, files).groups.map((g) => g.files), [['src/a.ts', 'new.ts', 'logo.png']]);

const input = guideInput({ title: 'T', description: '' }, files);
assert.ok(input.includes('pnpm-lock.yaml (added, +1 -0) [generated]') && !input.includes('+lock') && input.includes('-keep') === false);
assert.ok(guideInput({ title: 'T' }, files, 10).includes('--- src/a.ts\n(truncated)'));

assert.deepEqual(segments('Use `a.b` here:\n```tsx\nconst x = <A />;\n```\ndone ```open'), [
  { type: 'text', text: 'Use ' },
  { type: 'code', text: 'a.b' },
  { type: 'text', text: ' here:' },
  { type: 'block', lang: 'tsx', text: 'const x = <A />;' },
  { type: 'text', text: 'done ```open' },
]);

// Tour: a.ts has 2 hunks, b.ts 1, plus a test, a lockfile and a binary.
const tf = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-one
+ONE
@@ -9 +9 @@
-nine
+NINE
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
 b
+c
diff --git a/a.test.ts b/a.test.ts
--- a/a.test.ts
+++ b/a.test.ts
@@ -1 +1 @@
-t
+T
diff --git a/yarn.lock b/yarn.lock
--- a/yarn.lock
+++ b/yarn.lock
@@ -1 +1 @@
-l
+L
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`);
assert.deepEqual(tourHunks(tf).map((h) => [h.id, h.path, h.hunk.start]), [['H1', 'a.ts', 1], ['H2', 'a.ts', 9], ['H3', 'b.ts', 1]]);
const ti = tourInput({ title: 'T' }, tf);
assert.ok(ti.includes('### a.ts\nH1 @@ -1 +1 @@\n-one\n+ONE\nH2 ') && ti.includes('a.test.ts') && !ti.includes('+T') && !ti.includes('+L'));
assert.ok(!tourInput({ title: 'T' }, tf, 10).includes('H1'));
const tour = normalizeTour({ briefing: 'b', tests: 'tt', questions: ['q'], stops: [{ title: 'S1', explanation: 'e', check: 'c', hunks: ['H3', 'H2', 'H99', 'H3'] }, { title: 'dup', hunks: ['H2'] }] }, tf);
assert.deepEqual(tour.stops.map((s) => [s.title, s.parts.map((p) => [p.path, p.hunks.map((x) => x.start)]), s.files]), [
  ['S1', [['b.ts', [1]], ['a.ts', [9]]], []],
  ['Not covered by the tour', [['a.ts', [1]]], ['img.png']],
  ['Tests', [], ['a.test.ts']],
  ['Generated files', [], ['yarn.lock']],
]);
assert.equal(tour.stops[2].explanation, 'tt');
// Whatever the LLM returns (here: nothing), every file is still in exactly one stop.
const covered = normalizeTour(null, tf).stops.flatMap((s) => [...s.parts.map((p) => p.path), ...s.files]);
assert.deepEqual(covered.sort(), tf.map((f) => f.path).sort());

console.log('ok');
