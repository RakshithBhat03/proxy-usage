/**
 * Builds the UI and publishes it into ./web, which the running container serves (UI_DIR), so UI
 * changes go live without restarting the server or interrupting the collector.
 *
 *   npm run publish:ui
 *
 * The swap is safe while the page is open: new content-hashed assets are copied in first, then
 * index.html is replaced with an atomic rename. Assets from earlier builds are kept for a week after
 * they stop being current (tracked in web/.publish-log.json) so tabs still running an older build can
 * lazy-load their chunks.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.ui-build');
const web = path.join(root, 'web');
const logFile = path.join(web, '.publish-log.json');
const KEEP_OLD_ASSETS_MS = 7 * 24 * 3600_000;

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run('npx', ['tsc', '-b', '--noEmit']);
run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir']);

mkdirSync(path.join(web, 'assets'), { recursive: true });
const built = new Set(readdirSync(path.join(out, 'assets')));

// 1. Hashed assets first: the old index.html keeps working while they arrive.
cpSync(path.join(out, 'assets'), path.join(web, 'assets'), { recursive: true });

// 2. Other root files (logo etc.), then index.html last via rename.
for (const name of readdirSync(out)) {
  if (name === 'assets' || name === 'index.html') continue;
  cpSync(path.join(out, name), path.join(web, name), { recursive: true });
}
const tmp = path.join(web, '.index.html.tmp');
copyFileSync(path.join(out, 'index.html'), tmp);
renameSync(tmp, path.join(web, 'index.html'));

// 3. Prune assets of builds that stopped being current more than a week ago. Each log entry is
//    current from its `at` until the next entry's `at`.
const now = Date.now();
let log = [];
try {
  log = JSON.parse(readFileSync(logFile, 'utf8'));
} catch {
  // First publish (or unreadable log): nothing older is known, so nothing is pruned.
}
log.push({ at: now, assets: [...built] });
log = log.filter((entry, i) => i === log.length - 1 || now - log[i + 1].at <= KEEP_OLD_ASSETS_MS);
const keep = new Set(log.flatMap((entry) => entry.assets));
let pruned = 0;
if (log.length > 1 || existsSync(logFile)) {
  for (const name of readdirSync(path.join(web, 'assets'))) {
    if (keep.has(name)) continue;
    rmSync(path.join(web, 'assets', name), { force: true });
    pruned++;
  }
}
writeFileSync(logFile, `${JSON.stringify(log)}\n`);
if (existsSync(out)) rmSync(out, { recursive: true, force: true });

console.log(`\nUI published to ${path.relative(root, web)}/ (${built.size} assets${pruned ? `, pruned ${pruned} old` : ''}). Reload the page to see it.`);
