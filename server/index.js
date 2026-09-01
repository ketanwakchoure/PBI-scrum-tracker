import express from 'express';
import fs from 'node:fs';
import config from './config.js';
import { buildSprintData } from './transform.js';
import { TEAMS, DEFAULT_TEAM_KEY, resolveTeam, matchesTeam } from './teams.js';
import { loadLive, fetchTrimmedBoardSprints } from './loader.js';
import { loadReleases, loadEpicsData } from './epics.js';
import { loadSprintTrackers, applyGrooming, getSubtaskCreateMeta } from './grooming.js';

const app = express();
app.use(express.json());

const DAY_MS = 24 * 60 * 60 * 1000;

const dataCache = new Map(); // key: `${teamKey}:${sprintId}`
let sprintListCache = { data: null, at: 0 };
const refreshing = new Set(); // cache keys with a background refresh in flight

function loadSnapshotRaw() {
  if (!fs.existsSync(config.snapshotPath)) {
    throw new Error(
      'No Jira credentials configured and no local snapshot found. ' +
        'Set JIRA_EMAIL and JIRA_API_TOKEN in .env (see .env.example) to enable live mode.'
    );
  }
  return JSON.parse(fs.readFileSync(config.snapshotPath, 'utf8'));
}

function snapshotSprintMeta() {
  const raw = loadSnapshotRaw();
  for (const issue of raw.issues) {
    const sprints = issue.fields[config.sprintField];
    const active = Array.isArray(sprints) ? sprints.find((s) => s.state === 'active') : null;
    if (active) return active;
  }
  return null;
}

function loadSnapshot(sprintId, team) {
  const raw = loadSnapshotRaw();
  const issues = (raw.issues || []).filter((issue) =>
    matchesTeam(issue.fields?.[config.teamField], team)
  );
  return buildSprintData({
    issues,
    mode: 'snapshot',
    fetchedAt: raw.fetchedAt,
    sprintId,
    team
  });
}

async function loadFresh(sprintId, team, key) {
  const data = config.liveMode
    ? await loadLive(sprintId, team, await getSprintList().catch(() => []))
    : loadSnapshot(sprintId, team);
  dataCache.set(key, { data, at: Date.now() });
  return data;
}

async function getSprintData(sprintId, team, force = false) {
  const key = `${team.key}:${sprintId || ''}`;
  const cached = dataCache.get(key);
  if (!force && cached) {
    // Sprints that ended more than a day ago barely change: long TTL.
    const endedLongAgo =
      cached.data?.sprint?.endDate &&
      new Date(cached.data.sprint.endDate).getTime() < Date.now() - DAY_MS;
    const ttl = endedLongAgo ? config.closedCacheTtlMs : config.cacheTtlMs;
    if (Date.now() - cached.at < ttl) return cached.data;
    // Stale-while-revalidate: serve the stale copy instantly and refresh in
    // the background (the header shows "data as of" so staleness is visible).
    if (!refreshing.has(key)) {
      refreshing.add(key);
      loadFresh(sprintId, team, key)
        .catch((err) => console.error(`logName=backgroundRefreshFailed, key=${key}, error=${err.message}`))
        .finally(() => refreshing.delete(key));
    }
    return cached.data;
  }
  return loadFresh(sprintId, team, key);
}

async function getSprintList() {
  if (!config.liveMode) {
    const meta = snapshotSprintMeta();
    return meta
      ? [{ id: meta.id, name: meta.name, state: meta.state, startDate: meta.startDate, endDate: meta.endDate, goal: meta.goal || null }]
      : [];
  }
  if (sprintListCache.data && Date.now() - sprintListCache.at < 10 * 60 * 1000) {
    return sprintListCache.data;
  }
  const sprints = await fetchTrimmedBoardSprints();
  sprintListCache = { data: sprints, at: Date.now() };
  return sprints;
}

app.get('/api/teams', (_req, res) => {
  res.json({
    defaultTeam: DEFAULT_TEAM_KEY,
    teams: TEAMS.map(({ key, name }) => ({ key, name }))
  });
});

app.get('/api/sprints', async (_req, res) => {
  try {
    res.json({ liveMode: config.liveMode, sprints: await getSprintList() });
  } catch (err) {
    console.error(`logName=sprintListFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/sprint', async (req, res) => {
  try {
    const sprintId = req.query.sprintId ? String(req.query.sprintId) : null;
    const team = resolveTeam(req.query.team);
    const data = await getSprintData(sprintId, team, req.query.refresh === 'true');
    res.json(data);
  } catch (err) {
    console.error(`logName=sprintDataFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

const epicCache = new Map(); // key -> { data, at }; releases + epic trees
const EPIC_TTL = 10 * 60 * 1000;

async function cachedEpic(key, force, loader) {
  const hit = epicCache.get(key);
  if (!force && hit && Date.now() - hit.at < EPIC_TTL) return hit.data;
  const data = await loader();
  epicCache.set(key, { data, at: Date.now() });
  return data;
}

app.get('/api/releases', async (req, res) => {
  try {
    if (!config.liveMode) throw new Error('Epic view requires live Jira credentials (.env).');
    const team = resolveTeam(req.query.team);
    const releases = await cachedEpic(`releases:${team.key}`, false, () => loadReleases(team));
    res.json({ team: { key: team.key, name: team.name }, releases });
  } catch (err) {
    console.error(`logName=releasesFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/epics', async (req, res) => {
  try {
    if (!config.liveMode) throw new Error('Epic view requires live Jira credentials (.env).');
    if (!req.query.release) throw new Error('release query param is required');
    const team = resolveTeam(req.query.team);
    const release = String(req.query.release);
    const data = await cachedEpic(
      `epics:${team.key}:${release}`,
      req.query.refresh === 'true',
      () => loadEpicsData(team, release)
    );
    res.json(data);
  } catch (err) {
    console.error(`logName=epicsFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/grooming/sprint', async (req, res) => {
  try {
    if (!config.liveMode) throw new Error('Grooming requires live Jira credentials (.env).');
    const team = resolveTeam(req.query.team);
    const sprintId = req.query.sprintId ? String(req.query.sprintId) : null;
    res.json(await loadSprintTrackers(team, sprintId));
  } catch (err) {
    console.error(`logName=groomingLoadFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/grooming/apply', async (req, res) => {
  try {
    if (!config.liveMode) throw new Error('Grooming requires live Jira credentials (.env).');
    const { creates, spUpdates } = req.body || {};
    if (!Array.isArray(creates) && !Array.isArray(spUpdates)) {
      return res.status(400).json({ error: 'creates or spUpdates array required' });
    }
    const meta = await getSubtaskCreateMeta().catch(() => []);
    const results = await applyGrooming(
      { creates: creates || [], spUpdates: spUpdates || [] },
      meta
    );
    const created = results.createResults.filter((r) => r.success).length;
    const updated = results.spResults.filter((r) => r.success).length;
    console.log(`logName=groomingApplied, created=${created}, spUpdated=${updated}`);
    res.json(results);
  } catch (err) {
    console.error(`logName=groomingApplyFailed, error=${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, liveMode: config.liveMode });
});

app.listen(config.port, () => {
  console.log(
    `scrum-tracker server on http://localhost:${config.port} (mode: ${config.liveMode ? 'live' : 'snapshot'})`
  );
});
