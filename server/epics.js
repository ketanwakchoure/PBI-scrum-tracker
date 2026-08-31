import config from './config.js';
import { searchIssues } from './jira.js';
import { teamJql } from './teams.js';

// Epic view: releases come from fixVersions on the team's epics; each epic
// rolls up SP from its tasks, which roll up from their subtasks (leaf level).

const EPIC_FIELDS = ['summary', 'status', 'fixVersions', config.storyPointsField];
const CHILD_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'parent', config.storyPointsField];

function numericReleaseSort(a, b) {
  // Release names like "2026.10.1" need numeric-aware descending order
  // (plain string sort would put 2026.8 above 2026.10).
  const pa = a.name.split('.').map(Number);
  const pb = b.name.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (!Number.isNaN(d) && d !== 0) return d;
  }
  return b.name.localeCompare(a.name);
}

export const NO_RELEASE = '(no release)';

export async function loadReleases(team) {
  const epics = await searchIssues(
    `project = ${config.projectKey} AND issuetype = Epic AND ${teamJql(team)}`,
    ['fixVersions']
  );
  const map = new Map();
  let noRelease = 0;
  for (const epic of epics) {
    const versions = epic.fields.fixVersions || [];
    if (!versions.length) {
      noRelease++;
      continue;
    }
    for (const v of versions) {
      if (!map.has(v.name)) map.set(v.name, { name: v.name, released: Boolean(v.released), epicCount: 0 });
      map.get(v.name).epicCount++;
    }
  }
  const releases = [...map.values()].sort(numericReleaseSort);
  if (noRelease) releases.push({ name: NO_RELEASE, released: false, epicCount: noRelease });
  return releases;
}

function statusCategory(issue) {
  return issue.fields.status?.statusCategory?.key || 'new';
}

function bucketize(leaves) {
  const sum = { totalSP: 0, doneSP: 0, inProgressSP: 0, todoSP: 0, doneCount: 0, count: leaves.length };
  for (const leaf of leaves) {
    const sp = leaf.fields[config.storyPointsField] || 0;
    sum.totalSP += sp;
    const cat = statusCategory(leaf);
    if (cat === 'done') {
      sum.doneSP += sp;
      sum.doneCount++;
    } else if (cat === 'indeterminate') sum.inProgressSP += sp;
    else sum.todoSP += sp;
  }
  return sum;
}

const round1 = (n) => Math.round(n * 10) / 10;
function rounded(sum) {
  return {
    totalSP: round1(sum.totalSP),
    doneSP: round1(sum.doneSP),
    inProgressSP: round1(sum.inProgressSP),
    todoSP: round1(sum.todoSP),
    remainingSP: round1(sum.totalSP - sum.doneSP)
  };
}

async function searchByParents(parentKeys, fields) {
  const results = [];
  for (let i = 0; i < parentKeys.length; i += 50) {
    const chunk = parentKeys.slice(i, i + 50);
    results.push(...(await searchIssues(`parent in (${chunk.join(',')})`, fields)));
  }
  return results;
}

export async function loadEpicsData(team, releaseName) {
  const releaseClause =
    releaseName === NO_RELEASE ? 'fixVersion is EMPTY' : `fixVersion = "${releaseName.replace(/"/g, '')}"`;
  const epics = await searchIssues(
    `project = ${config.projectKey} AND issuetype = Epic AND ${teamJql(team)} AND ${releaseClause} ORDER BY created DESC`,
    EPIC_FIELDS
  );

  const tasks = epics.length ? await searchByParents(epics.map((e) => e.key), CHILD_FIELDS) : [];
  const taskParents = tasks.filter((t) => !t.fields.issuetype?.subtask);
  const subtasks = taskParents.length
    ? await searchByParents(taskParents.map((t) => t.key), CHILD_FIELDS)
    : [];

  const subtasksByParent = {};
  for (const s of subtasks) {
    const p = s.fields.parent?.key;
    if (p) (subtasksByParent[p] = subtasksByParent[p] || []).push(s);
  }
  const tasksByEpic = {};
  for (const t of tasks) {
    const p = t.fields.parent?.key;
    if (p) (tasksByEpic[p] = tasksByEpic[p] || []).push(t);
  }

  const shape = (issue) => ({
    key: issue.key,
    summary: issue.fields.summary,
    url: `${config.jiraBaseUrl}/browse/${issue.key}`,
    type: issue.fields.issuetype?.name || 'Epic',
    status: issue.fields.status?.name || 'Unknown',
    statusCategory: statusCategory(issue),
    assignee: issue.fields.assignee?.displayName || null,
    sp: round1(issue.fields[config.storyPointsField] || 0)
  });

  // Rollups accumulate RAW sums and round only for display; rounding per node
  // and then summing would drift by up to ±0.05 per child.
  const addRaw = (a, b) => ({
    totalSP: a.totalSP + b.totalSP,
    doneSP: a.doneSP + b.doneSP,
    inProgressSP: a.inProgressSP + b.inProgressSP,
    todoSP: a.todoSP + b.todoSP
  });
  const zero = () => ({ totalSP: 0, doneSP: 0, inProgressSP: 0, todoSP: 0 });

  let releaseRaw = zero();
  const epicNodes = epics.map((epic) => {
    let epicRaw = zero();
    const taskNodes = (tasksByEpic[epic.key] || []).map((task) => {
      const kids = subtasksByParent[task.key] || [];
      // Leaf rule (same as the Sprint Overview): a task's SP lives on its
      // subtasks when it has them, otherwise on the task itself.
      const leaves = kids.length ? kids : [task];
      const raw = bucketize(leaves);
      epicRaw = addRaw(epicRaw, raw);
      return {
        ...shape(task),
        ...rounded(raw),
        subtasks: kids
          .map(shape)
          .sort((a, b) => (a.statusCategory === 'done') - (b.statusCategory === 'done') || b.sp - a.sp)
      };
    });
    taskNodes.sort((a, b) => b.remainingSP - a.remainingSP || b.totalSP - a.totalSP);
    releaseRaw = addRaw(releaseRaw, epicRaw);

    return {
      ...shape(epic),
      ...rounded(epicRaw),
      taskCount: taskNodes.length,
      doneTaskCount: taskNodes.filter((t) => t.statusCategory === 'done').length,
      tasks: taskNodes
    };
  });
  epicNodes.sort((a, b) => b.remainingSP - a.remainingSP || b.totalSP - a.totalSP);

  const totals = rounded(releaseRaw);

  return {
    mode: 'live',
    fetchedAt: new Date().toISOString(),
    team: { key: team.key, name: team.name },
    release: releaseName,
    totals,
    epics: epicNodes
  };
}
