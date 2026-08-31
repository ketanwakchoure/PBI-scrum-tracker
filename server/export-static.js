// Exports pre-computed sprint data as static JSON for GitHub Pages.
// Usage: node server/export-static.js [--out <dir>] [--closed <n>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS, DEFAULT_TEAM_KEY } from './teams.js';
import { loadLive, fetchTrimmedBoardSprints, assertLiveMode } from './loader.js';
import { loadReleases, loadEpicsData, NO_RELEASE } from './epics.js';

// Deterministic filename slug for a release (mirrored in client/src/api.js).
const releaseSlug = (name) => name.replace(/[^a-zA-Z0-9.]/g, '_');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = path.resolve(argValue('--out', path.join(__dirname, '..', 'client', 'public', 'data')));
// Closed sprints to export; the picker in static mode only offers exported ones.
const closedCount = Number(argValue('--closed', '6'));

assertLiveMode();

const sprints = await fetchTrimmedBoardSprints(closedCount);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const write = (rel, data) => {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

let exported = 0;
for (const team of TEAMS) {
  for (const target of [null, ...sprints]) {
    const label = target ? String(target.id) : 'active';
    try {
      const data = await loadLive(target?.id ?? null, team, sprints);
      data.mode = 'static';
      write(path.join(team.key, `${label}.json`), data);
      exported++;
      console.log(`exported ${team.key}/${label} (${data.sprint?.name || 'no sprint'})`);
    } catch (err) {
      console.error(`logName=exportFailed, team=${team.key}, sprint=${label}, error=${err.message}`);
    }
  }
}

// Epic view: per team, export the unreleased releases plus the two most
// recently released ones (full history would blow up CI time).
const releasedCount = Number(argValue('--released', '2'));
for (const team of TEAMS) {
  try {
    const releases = await loadReleases(team);
    const chosen = releases.filter(
      (r, i) =>
        r.name !== NO_RELEASE &&
        (!r.released || releases.filter((x) => x.released).indexOf(r) < releasedCount)
    );
    for (const r of chosen) {
      try {
        const data = await loadEpicsData(team, r.name);
        data.mode = 'static';
        write(path.join('epics', team.key, `${releaseSlug(r.name)}.json`), data);
        exported++;
        console.log(`exported epics/${team.key}/${r.name} (${data.epics.length} epics)`);
      } catch (err) {
        console.error(`logName=epicExportFailed, team=${team.key}, release=${r.name}, error=${err.message}`);
      }
    }
    write(path.join('epics', team.key, 'releases.json'), { releases: chosen });
  } catch (err) {
    console.error(`logName=releasesExportFailed, team=${team.key}, error=${err.message}`);
  }
}

write('index.json', {
  generatedAt: new Date().toISOString(),
  defaultTeam: DEFAULT_TEAM_KEY,
  teams: TEAMS.map(({ key, name }) => ({ key, name })),
  sprints
});
console.log(`done: ${exported} payloads -> ${outDir}`);
