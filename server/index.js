import express from 'express';
import fs from 'node:fs';
import config from './config.js';
import { buildSprintData } from './transform.js';
import { TEAMS, DEFAULT_TEAM_KEY, resolveTeam } from './teams.js';
import {
  fetchSprintIssues,
  fetchIssueChangelogs,
  fetchStatusCategoryMap,
  fetchBoardSprints
} from './jira.js';

const app = express();

const DAY_MS = 24 * 60 * 60 * 1000;

const dataCache = new Map(); // key: `${teamKey}:${sprintId}`
let sprintListCache = { data: null, at: 0 };
let statusMapCache = { data: null, at: 0 };
// Per-issue changelog cache keyed by the issue's `updated` timestamp:
// an issue whose `updated` hasn't moved cannot have new changelog entries.
const changelogCache = new Map(); // issueId -> { updated, entries }
const refreshing = new Set(); // cache keys with a background refresh in flight

async function getStatusCategoryMap() {
  if (statusMapCache.data && Date.now() - statusMapCache.at < 6 * 60 * 60 * 1000) {
    return statusMapCache.data;
  }
  const map = await fetchStatusCategoryMap();
  statusMapCache = { data: map, at: Date.now() };
  return map;
}

async function getChangelogsFor(issues) {
  const need = issues.filter((i) => {
    const c = changelogCache.get(String(i.id));
    return !c || c.updated !== i.fields.updated;
  });
  if (need.length) {
    const fetched = await fetchIssueChangelogs(need.map((i) => String(i.id)));
    for (const i of need) {
      changelogCache.set(String(i.id), {
        updated: i.fields.updated,
        entries: fetched[String(i.id)] || []
      });
    }
  }
  const out = {};
  for (const i of issues) {
    out[String(i.id)] = changelogCache.get(String(i.id))?.entries || [];
  }
  return out;
}

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
  const issues = (raw.issues || []).filter((issue) => {
    const t = issue.fields?.[config.teamField];
    return t && (t.id === team.jiraTeamId || t.name === team.name);
  });
  return buildSprintData({
    issues,
    mode: 'snapshot',
    fetchedAt: raw.fetchedAt,
    sprintId,
    team
  });
}

/**
 * Recover spillover that lost its sprint marker. Editing the Sprint field
 * (bulk edit / backlog drag) REPLACES its value, erasing the old sprint from
 * JQL. The changelog still records it, so for a closed sprint we scan the
 * next sprint's issues and merge back any whose changelog shows they were
 * moved into the target sprint.
 */
async function fetchLostSpillover(sprintMeta, sprints, team, knownIds) {
  // Applies to closed sprints (classic spillover) and the active sprint
  // (items descoped mid-sprint to a future sprint still shape the chart's
  // history until their removal day).
  if (!sprintMeta || !sprintMeta.startDate || sprintMeta.state === 'future') return null;
  // Spilled items can hop several sprints ahead before settling; scan a few.
  const nextSprints = sprints
    .filter((s) => s.startDate && s.startDate > sprintMeta.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 3);
  if (!nextSprints.length) return null;

  const seen = new Set(knownIds);
  const candidates = [];
  const nextIssueLists = await Promise.all(
    nextSprints.map((next) => fetchSprintIssues(next.id, team.jiraTeamId))
  );
  for (const nextIssues of nextIssueLists) {
    for (const issue of nextIssues) {
      if (seen.has(String(issue.id))) continue;
      seen.add(String(issue.id));
      candidates.push(issue);
    }
  }
  if (!candidates.length) return null;

  const candidateLogs = await getChangelogsFor(candidates);
  // Was the issue ever in the target sprint? Either side of a sprint-field
  // change proves it (creation inside the sprint leaves no "add" entry, but
  // the eventual removal records the sprint in fromSprints).
  const spilled = candidates.filter((i) =>
    (candidateLogs[String(i.id)] || []).some(
      (c) =>
        c.field === 'sprint' &&
        ((c.toSprints || '').includes(sprintMeta.name) ||
          (c.fromSprints || '').includes(sprintMeta.name))
    )
  );
  if (spilled.length) {
    console.log(
      `logName=spilloverRecovered, sprint=${sprintMeta.id}, team=${team.key}, count=${spilled.length}`
    );
  }
  return { spilled, candidateLogs };
}

async function loadLive(sprintId, team) {
  const [issues, sprints] = await Promise.all([
    fetchSprintIssues(sprintId, team.jiraTeamId),
    getSprintList().catch(() => [])
  ]);
  const sprintMeta = sprintId
    ? sprints.find((s) => s.id === Number(sprintId))
    : sprints.find((s) => s.state === 'active');

  // Base changelogs, status map, and spillover discovery are independent —
  // run all three concurrently.
  const knownIds = new Set(issues.map((i) => String(i.id)));
  const [baseLogs, statusCategoryMap, recovered] = await Promise.all([
    getChangelogsFor(issues).catch((err) => {
      console.error(`logName=changelogFetchFailed, error=${err.message}`);
      return null;
    }),
    getStatusCategoryMap().catch((err) => {
      console.error(`logName=statusMapFetchFailed, error=${err.message}`);
      return null;
    }),
    fetchLostSpillover(sprintMeta, sprints, team, knownIds).catch((err) => {
      console.error(`logName=spilloverRecoveryFailed, error=${err.message}`);
      return null;
    })
  ]);

  let changelogs = baseLogs;
  if (recovered) {
    issues.push(...recovered.spilled);
    changelogs = { ...(baseLogs || {}), ...recovered.candidateLogs };
  }
  return buildSprintData({
    issues,
    changelogs,
    statusCategoryMap,
    mode: 'live',
    fetchedAt: new Date().toISOString(),
    sprintId,
    sprintMeta,
    team
  });
}

async function loadFresh(sprintId, team, key) {
  const data = config.liveMode ? await loadLive(sprintId, team) : loadSnapshot(sprintId, team);
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
  const all = await fetchBoardSprints();
  // Keep the dropdown manageable: every future/active sprint, last 12 closed.
  const closed = all.filter((s) => s.state === 'closed').slice(0, 12);
  const sprints = all.filter((s) => s.state !== 'closed').concat(closed);
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, liveMode: config.liveMode });
});

app.listen(config.port, () => {
  console.log(
    `iota-sprint-tracker server on http://localhost:${config.port} (mode: ${config.liveMode ? 'live' : 'snapshot'})`
  );
});
