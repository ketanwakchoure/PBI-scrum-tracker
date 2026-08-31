import config from './config.js';
import { buildSprintData } from './transform.js';
import {
  fetchSprintIssues,
  fetchIssueChangelogs,
  fetchStatusCategoryMap,
  fetchBoardSprints
} from './jira.js';

// Shared live-mode loading pipeline, used by both the Express server and the
// static export script (CI → GitHub Pages).

let statusMapCache = { data: null, at: 0 };
// Per-issue changelog cache keyed by the issue's `updated` timestamp:
// an issue whose `updated` hasn't moved cannot have new changelog entries.
const changelogCache = new Map(); // issueId -> { updated, entries }

export async function getStatusCategoryMap() {
  if (statusMapCache.data && Date.now() - statusMapCache.at < 6 * 60 * 60 * 1000) {
    return statusMapCache.data;
  }
  const map = await fetchStatusCategoryMap();
  statusMapCache = { data: map, at: Date.now() };
  return map;
}

export async function getChangelogsFor(issues) {
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

// Board sprints trimmed for the picker: every future/active sprint plus the
// most recent closed ones.
export async function fetchTrimmedBoardSprints(closedCount = 12) {
  const all = await fetchBoardSprints();
  const closed = all.filter((s) => s.state === 'closed').slice(0, closedCount);
  return all.filter((s) => s.state !== 'closed').concat(closed);
}

/**
 * Recover spillover that lost its sprint marker. Editing the Sprint field
 * (bulk edit / backlog drag) REPLACES its value, erasing the old sprint from
 * JQL. The changelog still records it, so we scan subsequent sprints' issues
 * and merge back any whose changelog shows they were in the target sprint.
 * Applies to closed sprints (classic spillover) and the active sprint (items
 * descoped mid-sprint still shape the chart's history until removal day).
 */
export async function fetchLostSpillover(sprintMeta, sprints, team, knownIds) {
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

export async function loadLive(sprintId, team, sprints) {
  const issues = await fetchSprintIssues(sprintId, team.jiraTeamId);
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

export function assertLiveMode() {
  if (!config.liveMode) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN must be set (env or .env).');
  }
}
