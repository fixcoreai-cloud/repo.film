#!/usr/bin/env node
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/analyze');

const HELP = `
  repo.film · every repository is a documentary

  Usage
    npx repo.film [path] [options]

  Options
    -o, --out <file>     where to write the film (default: <repo>.film.html)
    -n, --max <count>    only film the most recent <count> commits
    --name <name>        title for the film (default: from the git remote)
    --open               open the film in your browser when it is done
    -h, --help           show this

  Examples
    npx repo.film
    npx repo.film ~/code/react --open
`;

function parseArgs(argv) {
  const a = { dir: '.', out: null, max: 0, name: null, open: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '-h' || v === '--help') { console.log(HELP); process.exit(0); }
    else if (v === '-o' || v === '--out') a.out = argv[++i];
    else if (v === '-n' || v === '--max') a.max = parseInt(argv[++i], 10) || 0;
    else if (v === '--name') a.name = argv[++i];
    else if (v === '--open') a.open = true;
    else if (!v.startsWith('-')) a.dir = v;
    else { console.error(`Unknown option ${v}\n${HELP}`); process.exit(1); }
  }
  return a;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function remoteInfo(dir) {
  let url = '';
  try { url = git(dir, ['remote', 'get-url', 'origin']); } catch {}
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?$/i);
  if (m) return { name: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` };
  const gl = url.match(/(gitlab\.com|codeberg\.org)[/:](.+?)(\.git)?$/i);
  if (gl) return { name: gl[2], url: `https://${gl[1]}/${gl[2]}`, kind: gl[1] };
  return { name: path.basename(path.resolve(dir)), url: null };
}

// Streams `git log` so huge histories don't need to fit in one string.
function readCommits(dir, max) {
  return new Promise((resolve, reject) => {
    const args = ['-C', dir, 'log', '--no-renames', '--use-mailmap', '--numstat',
      '--format=%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%ai%x1f%s'];
    if (max) args.push('-n', String(max));
    const p = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const commits = [];
    let buf = '', err = '', cur = null;
    const line = l => {
      if (l.startsWith('\x1e')) {
        const [sha, parents, name, email, at, ai, subject] = l.slice(1).split('\x1f');
        const hour = parseInt(ai.slice(11, 13), 10); // author's own local hour
        const d = new Date(ai.slice(0, 10) + 'T00:00:00Z').getUTCDay();
        cur = { sha, parents: parents ? parents.split(' ').length : 0, name, email, t: +at * 1000, hour, dow: d, subject: subject || '', files: [] };
        commits.push(cur);
        if (commits.length % 5000 === 0) process.stderr.write(`\r  reading history… ${commits.length.toLocaleString('en-US')} commits`);
      } else if (cur && l) {
        const [i, d, ...rest] = l.split('\t');
        if (rest.length) cur.files.push({ path: rest.join('\t'), ins: i === '-' ? 0 : +i, del: d === '-' ? 0 : +d });
      }
    };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      if (buf) line(buf);
      process.stderr.write('\r\x1b[K');
      if (code !== 0) return reject(new Error(err.trim() || `git log exited with ${code}`));
      resolve(commits);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try { git(args.dir, ['rev-parse', '--git-dir']); }
  catch { console.error(`  ${path.resolve(args.dir)} is not a git repository.`); process.exit(1); }
  try {
    if (git(args.dir, ['rev-parse', '--is-shallow-repository']) === 'true')
      console.error('  heads up: this is a shallow clone, so the film only covers the commits you have. Run `git fetch --unshallow` for the full story.');
  } catch {}

  const info = remoteInfo(args.dir);
  if (args.name) info.name = args.name;
  const t0 = Date.now();
  console.error(`  🎬 filming ${info.name}`);
  const commits = await readCommits(args.dir, args.max);
  const story = analyze(commits, info);

  const template = fs.readFileSync(path.join(__dirname, '..', 'src', 'template.html'), 'utf8');
  const json = JSON.stringify(story).replace(/</g, '\\u003c');
  const html = template.replace('/*__STORY__*/null', () => json).replace(/__TITLE__/g, () => esc(info.name));
  const out = args.out || `${info.name.replace(/[^\w.-]+/g, '-')}.film.html`;
  fs.writeFileSync(out, html);

  const s = story.totals;
  console.error(`  ✓ ${s.commits.toLocaleString('en-US')} commits · ${s.people.toLocaleString('en-US')} people · ${s.years} years · ${story.eras.length} chapters`);
  console.error(`  ✓ ${path.resolve(out)} (${(html.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (args.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [out], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

main().catch(e => { console.error('  ✗ ' + e.message); process.exit(1); });
