'use strict';
// Turns raw commits into the chapters of a film. Pure functions, no I/O.
// Every fact keeps the sha it came from so the page can cite it.

const NOISE_PATH = /(^|\/)(node_modules|vendor|third_party|dist|build|coverage|\.yarn)\/|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock)$|\.min\.(js|css)$|\.(map|snap)$/;
const BOT = /\[bot\]|^dependabot|^renovate|^github-actions|^greenkeeper|bot$/i;
const STOP = new Set(('a an the and or but of to in on for with from by at as is are was were be been it its this that these those into ' +
  'not no do does did use using used add adds added update updates updated fix fixes fixed remove removes removed make makes ' +
  'when if then than so up out more some all can should now new via also only just over after before into about pr issue ' +
  'merge pull request branch master main from x v co authored signed off revert reverts commit commits chore feat docs test tests ' +
  'refactor bump version release changelog minor patch support').split(/\s+/));

const DAY = 864e5;
const isRevert = s => /^revert\b|^reverts?\s/i.test(s);
const isFix = s => /^(fix|fixes|fixed|bugfix|hotfix)\b|^fix\(|\bfix(es|ed)? #?\d/i.test(s);
const isRelease = s => /^(v?\d+\.\d+\.\d+(-[\w.]+)?)$|^release\b|^(chore\()?release\)?:?\s*v?\d|^bump version|^\d+\.\d+\.\d+$/i.test(s.trim());

function area(path) {
  const parts = path.split('/');
  if (parts.length === 1) return '(root)';
  if (/^(packages|src|lib|apps|crates|modules|plugins|libs|internal|pkg|cmd)$/.test(parts[0]) && parts.length > 2) return parts[0] + '/' + parts[1];
  return parts[0];
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function analyze(commits, meta = {}) {
  // commits: [{ sha, parents, name, email, t (ms), hour, dow, subject, files: [{ path, ins, del }] }], oldest first
  commits = commits.slice().sort((a, b) => a.t - b.t);
  if (!commits.length) throw new Error('No commits to film.');

  // ---- identities: one person per email, named by their most used name
  const people = new Map();
  const keyOf = c => (c.email || c.name).toLowerCase();
  for (const c of commits) {
    const k = keyOf(c);
    let p = people.get(k);
    if (!p) people.set(k, p = { names: new Map(), commits: 0, first: null, last: null, ins: 0, del: 0, night: 0, weekend: 0, areas: new Map(), hours: new Array(24).fill(0) });
    p.names.set(c.name, (p.names.get(c.name) || 0) + 1);
  }
  // merge people who share a name (same human, several emails)
  const byName = new Map();
  for (const [k, p] of people) {
    const name = topN(p.names, 1)[0][0];
    p.name = name;
    if (byName.has(name.toLowerCase())) people.set(k, byName.get(name.toLowerCase()));
    else byName.set(name.toLowerCase(), p);
  }
  const personOf = c => people.get(keyOf(c));

  // ---- per-commit stats
  let ins = 0, del = 0;
  const files = new Set();
  const month = new Map(); // yyyy-mm -> { commits, net }
  const heat = [...Array(7)].map(() => new Array(24).fill(0));
  const words = new Map();
  for (const c of commits) {
    c.merge = c.parents > 1;
    c.ins = 0; c.del = 0; c.nfiles = 0;
    for (const f of c.files) {
      files.add(f.path);
      if (NOISE_PATH.test(f.path)) continue;
      c.ins += f.ins; c.del += f.del; c.nfiles++;
    }
    ins += c.ins; del += c.del;
    const p = personOf(c);
    p.commits++; if (!p.first) p.first = c; p.last = c; p.ins += c.ins; p.del += c.del;
    p.hours[c.hour]++;
    if (c.hour < 5) p.night++;
    if (c.dow === 0 || c.dow === 6) p.weekend++;
    for (const f of c.files) { const a = area(f.path); p.areas.set(a, (p.areas.get(a) || 0) + 1); }
    heat[c.dow][c.hour]++;
    const m = new Date(c.t).toISOString().slice(0, 7);
    const mm = month.get(m) || { commits: 0, net: 0 };
    mm.commits++; mm.net += c.ins - c.del; month.set(m, mm);
    if (!c.merge) for (const w of c.subject.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1);
  }

  const first = commits[0], last = commits[commits.length - 1];
  const humans = [...new Set(people.values())].filter(p => !BOT.test(p.name));
  const ref = c => ({ sha: c.sha, short: c.sha.slice(0, 7), t: c.t, subject: c.subject, author: personOf(c).name, ins: c.ins, del: c.del, files: c.nfiles });

  // ---- arrivals
  const arrivals = [...new Set(commits.map(personOf))].filter(p => !BOT.test(p.name));
  const founders = arrivals.slice(0, 5).map(p => ({ name: p.name, commit: ref(p.first) }));
  const stranger = arrivals[1] ? { name: arrivals[1].name, commit: ref(arrivals[1].first), daysAfter: Math.round((arrivals[1].first.t - first.t) / DAY) } : null;

  // ---- eras: by year, or by quarter for young repos
  const spanDays = Math.max(1, (last.t - first.t) / DAY);
  const byQuarter = spanDays < 3 * 365;
  const eraKey = c => { const d = new Date(c.t); return byQuarter ? `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}` : String(d.getUTCFullYear()); };
  const eraMap = new Map();
  const seen = new Set();
  for (const c of commits) {
    const k = eraKey(c);
    let e = eraMap.get(k);
    if (!e) eraMap.set(k, e = { key: k, commits: [], authors: new Map(), areas: new Map(), newcomers: 0 });
    e.commits.push(c);
    const p = personOf(c);
    if (!BOT.test(p.name)) e.authors.set(p.name, (e.authors.get(p.name) || 0) + 1);
    if (!seen.has(p)) { seen.add(p); if (!BOT.test(p.name)) e.newcomers++; }
    for (const f of c.files) if (!NOISE_PATH.test(f.path)) { const a = area(f.path); e.areas.set(a, (e.areas.get(a) || 0) + f.ins + f.del); }
  }
  const eras = [...eraMap.values()].map(e => {
    const nonMerge = e.commits.filter(c => !c.merge);
    const releases = nonMerge.filter(c => isRelease(c.subject));
    const big = nonMerge.slice().sort((a, b) => (b.ins + b.del) - (a.ins + a.del))[0] || e.commits[0];
    const fixes = nonMerge.filter(c => isFix(c.subject) || isRevert(c.subject)).length;
    return {
      key: e.key, commits: e.commits.length, newcomers: e.newcomers,
      lead: topN(e.authors, 3).map(([name, n]) => ({ name, n })),
      areas: topN(e.areas, 3).map(([a]) => a),
      fixShare: nonMerge.length ? fixes / nonMerge.length : 0,
      releases: releases.length, firstRelease: releases[0] ? ref(releases[0]) : null, lastRelease: releases.length ? ref(releases[releases.length - 1]) : null,
      headline: ref(big),
    };
  });
  // each mood goes to exactly one era so the labels mean something
  const peak = eras.reduce((a, b) => (b.commits > a.commits ? b : a));
  const pick = (label, list, score) => {
    const free = list.filter(e => !e.mood);
    if (!free.length) return;
    const best = free.reduce((a, b) => (score(b) > score(a) ? b : a));
    if (score(best) > 0) best.mood = label;
  };
  eras.forEach(e => { e.mood = ''; });
  eras[0].mood = 'the beginning';
  if (eras.length > 1) peak.mood = peak.mood || 'the peak';
  pick('the arrivals', eras, e => e.newcomers);
  pick('the shipping season', eras, e => e.releases);
  pick('the repair years', eras.filter(e => e.commits >= 30), e => e.fixShare);
  if (eras.length > 3) pick('the quiet', eras.slice(1, -1), e => peak.commits - e.commits);

  // handovers: the era where the person doing most of the work changes
  const handovers = [];
  for (let i = 1; i < eras.length; i++) {
    const was = eras[i - 1].lead[0], now = eras[i].lead[0];
    if (was && now && was.name !== now.name) {
      eras[i].handover = { from: was.name, to: now.name };
      handovers.push({ era: eras[i].key, from: was.name, to: now.name });
    }
  }

  // ---- darkest week: reverts weigh triple
  const weeks = new Map();
  for (const c of commits) {
    if (c.merge) continue;
    const wk = Math.floor((c.t - 4 * DAY) / (7 * DAY)); // weeks starting Monday
    let w = weeks.get(wk);
    if (!w) weeks.set(wk, w = { start: wk * 7 * DAY + 4 * DAY, score: 0, reverts: [], fixes: [], total: 0 });
    w.total++;
    if (isRevert(c.subject)) { w.score += 3; w.reverts.push(c); }
    else if (isFix(c.subject)) { w.score += 1; w.fixes.push(c); }
  }
  const dark = [...weeks.values()].sort((a, b) => b.score - a.score || b.reverts.length - a.reverts.length)[0];
  const darkest = dark && dark.score >= 3 ? {
    start: dark.start, total: dark.total, reverts: dark.reverts.length, fixes: dark.fixes.length,
    scenes: [...dark.reverts, ...dark.fixes].sort((a, b) => a.t - b.t).slice(0, 6).map(ref),
  } : null;

  // ---- the great rewrite (most lines deleted) and the big bang (most lines added)
  const nonMerge = commits.filter(c => !c.merge);
  const rewrite = nonMerge.slice().sort((a, b) => b.del - a.del)[0];
  const bang = nonMerge.slice().sort((a, b) => b.ins - a.ins)[0];

  // ---- longest silence
  let gap = { ms: 0 };
  for (let i = 1; i < commits.length; i++) {
    const ms = commits[i].t - commits[i - 1].t;
    if (ms > gap.ms) gap = { ms, before: commits[i - 1], after: commits[i] };
  }
  const silence = gap.ms > 0 ? { days: Math.round(gap.ms / DAY), before: ref(gap.before), after: ref(gap.after) } : null;

  // ---- the cast
  const cast = humans.slice().sort((a, b) => b.commits - a.commits).slice(0, 12).map(p => ({
    name: p.name, commits: p.commits, ins: p.ins, del: p.del,
    first: p.first.t, last: p.last.t, years: +((p.last.t - p.first.t) / (365.25 * DAY)).toFixed(1),
    signature: (topN(p.areas, 1)[0] || ['(root)'])[0],
    nightShare: p.night / p.commits, weekendShare: p.weekend / p.commits,
    peakHour: p.hours.indexOf(Math.max(...p.hours)),
  }));
  const regulars = humans.filter(p => p.commits >= 20);
  const owl = regulars.slice().sort((a, b) => b.night / b.commits - a.night / a.commits)[0];
  const weekender = regulars.slice().sort((a, b) => b.weekend / b.commits - a.weekend / a.commits)[0];
  const longest = humans.slice().sort((a, b) => (b.last.t - b.first.t) - (a.last.t - a.first.t))[0];
  const awards = [];
  if (owl && owl.night / owl.commits > 0.08) awards.push({ title: 'Night Owl', name: owl.name, line: `${Math.round(owl.night / owl.commits * 100)}% of their commits landed between midnight and 5am` });
  if (weekender && weekender.weekend / weekender.commits > 0.25) awards.push({ title: 'Weekend Warrior', name: weekender.name, line: `${Math.round(weekender.weekend / weekender.commits * 100)}% of their commits on Saturdays and Sundays` });
  if (longest && longest.last.t - longest.first.t > 365 * DAY) awards.push({ title: 'Longest Serving', name: longest.name, line: `${((longest.last.t - longest.first.t) / (365.25 * DAY)).toFixed(1)} years between their first and latest commit` });
  const deleter = humans.filter(p => p.commits >= 20).sort((a, b) => (b.del / Math.max(1, b.ins)) - (a.del / Math.max(1, a.ins)))[0];
  if (deleter && deleter.del > deleter.ins) awards.push({ title: 'The Gardener', name: deleter.name, line: `deleted ${deleter.del.toLocaleString('en-US')} lines and added only ${deleter.ins.toLocaleString('en-US')}` });

  // ---- now
  const recentCut = last.t - 90 * DAY;
  const recentPeople = new Set(commits.filter(c => c.t >= recentCut).map(personOf).filter(p => !BOT.test(p.name)));

  // ---- soundtrack seed: the last 300 commits, repo.fm style
  const soundtrack = commits.slice(-300).map(c => ({ sha: c.sha, author: personOf(c).name, t: c.t, msg: c.subject }));

  return {
    meta: {
      name: meta.name || 'this repository', url: meta.url || null,
      generated: new Date().toISOString(),
    },
    totals: {
      commits: commits.length, people: humans.length, bots: people.size - humans.length,
      ins, del, files: files.size, first: first.t, last: last.t,
      years: +((last.t - first.t) / (365.25 * DAY)).toFixed(1),
      merges: commits.filter(c => c.merge).length,
    },
    first: { ...ref(first), files: first.files.slice(0, 12).map(f => f.path), fileCount: first.files.length },
    founders, stranger, eras, handovers, darkest,
    rewrite: rewrite ? ref(rewrite) : null, bang: bang ? ref(bang) : null,
    silence, cast, awards,
    heat, words: topN(words, 14).map(([w, n]) => ({ w, n })),
    months: [...month.entries()].sort().map(([m, v]) => ({ m, c: v.commits, net: v.net })),
    now: { last: ref(last), activePeople: recentPeople.size, activeNames: [...recentPeople].slice(0, 8).map(p => p.name) },
    credits: humans.slice().sort((a, b) => b.commits - a.commits).map(p => p.name),
    soundtrack,
  };
}

module.exports = { analyze, area, isRevert, isFix, isRelease };
