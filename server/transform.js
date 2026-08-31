import config from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateKey(d) {
  // Date key in IST (team timezone) so "done today" buckets match the team's day
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function endOfDayUtc(dateKey) {
  // 23:59:59 IST expressed as UTC epoch
  return new Date(`${dateKey}T23:59:59+05:30`).getTime();
}

function isWeekend(dateKey) {
  const dow = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function parseSp(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function findSprint(issues, sprintId) {
  for (const issue of issues) {
    const sprints = issue.fields[config.sprintField];
    if (Array.isArray(sprints)) {
      const match = sprintId
        ? sprints.find((s) => s.id === Number(sprintId))
        : sprints.find((s) => s.state === 'active');
      if (match) return match;
    }
  }
  return null;
}

/**
 * Determine when a work item was completed.
 * Priority: last changelog transition into a done-category status,
 * then resolutiondate, then statuscategorychangedate (if currently done).
 */
function resolveDoneAt(issue, changelog, statusCategoryMap, sprintEndCutoff = null) {
  const isDone = issue.fields.status?.statusCategory?.key === 'done';
  if (changelog && statusCategoryMap) {
    const doneTransitions = changelog
      .filter(
        (c) =>
          c.field === 'status' &&
          statusCategoryMap[(c.toStatus || '').toLowerCase()] === 'done'
      )
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    if (doneTransitions.length && isDone) {
      // Prefer the last transition inside the sprint window (done → reopened →
      // redone later should still credit the in-sprint completion).
      if (sprintEndCutoff) {
        const inWindow = doneTransitions.filter(
          (c) => new Date(c.created).getTime() <= sprintEndCutoff
        );
        if (inWindow.length) return inWindow[inWindow.length - 1].created;
      }
      return doneTransitions[doneTransitions.length - 1].created;
    }
  }
  if (!isDone) return null;
  return issue.fields.resolutiondate || issue.fields.statuscategorychangedate || null;
}

/**
 * When did this issue become part of the current sprint?
 * Live mode: last sprint-field change whose new value includes the active
 * sprint's name. Fallback (and snapshot mode): the issue's creation date —
 * trackers created mid-sprint grow the scope on the day they appear.
 */
function resolveAddedAt(issue, changelog, sprintName) {
  if (changelog && sprintName) {
    const adds = changelog
      .filter((c) => c.field === 'sprint' && (c.toSprints || '').includes(sprintName))
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    if (adds.length) return adds[adds.length - 1].created;
  }
  return issue.fields.created || null;
}

/**
 * Per-issue timelines that mirror Jira's burnup events:
 * - spAt(ts): the estimate value at a moment ("Estimate updated" events)
 * - inSprintAt(ts): sprint membership ("Added to/Removed from sprint" events)
 */
function buildTimelines(issue, changelog, sprintName, currentSp, { ignoreZeroing = false } = {}) {
  const createdTs = issue.fields.created ? new Date(issue.fields.created).getTime() : 0;

  const spChanges = (changelog || [])
    .filter((c) => c.field === 'sp')
    .sort((a, b) => new Date(a.created) - new Date(b.created));
  const initialSp = spChanges.length ? parseSp(spChanges[0].from) : currentSp;
  const spAt = (ts) => {
    let v = initialSp;
    for (const c of spChanges) {
      if (new Date(c.created).getTime() > ts) break;
      const next = parseSp(c.to);
      // Jira's BOARD burnup ignores estimate changes that zero out a positive
      // value (verified against the board's own event log: issues closed or
      // rejected with their estimate wiped still contribute the last positive
      // value). Applies to the burnup chart only, not leaf-level counting.
      if (ignoreZeroing && next === 0 && v > 0) continue;
      v = next;
    }
    return v;
  };

  let memberEvents = [];
  if (sprintName) {
    memberEvents = (changelog || [])
      .filter((c) => c.field === 'sprint')
      .sort((a, b) => new Date(a.created) - new Date(b.created))
      .map((c) => ({
        t: new Date(c.created).getTime(),
        // fromString/toString list every sprint on the issue at that moment,
        // so membership before the first event is exact (sprint assigned at
        // issue creation leaves no changelog entry).
        wasIn: (c.fromSprints || '').includes(sprintName),
        in: (c.toSprints || '').includes(sprintName)
      }));
  }
  const inSprintAt = (ts) => {
    if (ts < createdTs) return false;
    if (!memberEvents.length) return true;
    let state = memberEvents[0].wasIn;
    for (const e of memberEvents) {
      if (e.t <= ts) state = e.in;
      else break;
    }
    return state;
  };

  return { spAt, inSprintAt };
}

export function buildSprintData({
  issues,
  changelogs = null,
  statusCategoryMap = null,
  mode,
  fetchedAt,
  sprintId = null,
  sprintMeta = null,
  team = null
}) {
  const sprint = findSprint(issues, sprintId) || sprintMeta;
  // For a closed sprint, work only counts as done if it was completed before
  // the sprint ended; items finished later (or still open) are spillover.
  const sprintEndCutoff =
    sprint?.state === 'closed' && sprint?.endDate
      ? endOfDayUtc(toDateKey(sprint.endDate))
      : null;
  // Totals reflect the sprint's final state (Jira burnup semantics): the end
  // of the sprint for closed sprints, "now" for active ones.
  const refCutoff = sprintEndCutoff || Date.now();

  // SP is counted on LEAF items only: every subtask, plus parent-level items
  // (Tech design, Spike, Task, Bug, ...) that have no subtasks in the sprint.
  // Parents WITH subtasks carry a rollup of their children's SP; counting both
  // would double-count.
  const parentKeysWithChildren = new Set(
    issues
      .filter((i) => i.fields.issuetype?.subtask && i.fields.parent)
      .map((i) => i.fields.parent.key)
  );
  const leaves = issues.filter(
    (i) => i.fields.issuetype?.subtask || !parentKeysWithChildren.has(i.key)
  );
  const parentsByKey = {};
  for (const issue of issues) {
    if (!issue.fields.issuetype?.subtask) parentsByKey[issue.key] = issue;
  }

  const devMap = new Map();
  const allTrackers = []; // includes items removed mid-sprint

  // Jira's own burnup counts BOARD-level items (non-subtask issues with their
  // own estimates). The whole Burnup page is built from these records so it
  // matches Jira exactly; the Sprint Overview stays at child/leaf level.
  const boardRecords = [];
  const sprintStartTs = sprint?.startDate ? new Date(sprint.startDate).getTime() : null;
  for (const issue of issues) {
    if (issue.fields.issuetype?.subtask) continue;
    const changelog = changelogs?.[String(issue.id)];
    const currentSp = issue.fields[config.storyPointsField] || 0;
    const timeline = buildTimelines(issue, changelog, sprint?.name, currentSp, {
      ignoreZeroing: true
    });
    const doneAt = resolveDoneAt(issue, changelog, statusCategoryMap, sprintEndCutoff);
    // Jira excludes issues that were already completed before the sprint
    // started (they never appear in the sprint's burnup event log).
    if (doneAt && sprintStartTs && new Date(doneAt).getTime() < sprintStartTs) continue;
    const assignee = issue.fields.assignee;
    boardRecords.push({
      id: String(issue.id),
      devId: assignee?.accountId || 'unassigned',
      devName: assignee?.displayName || 'Unassigned',
      avatar: assignee?.avatarUrls?.['48x48'] || null,
      sp: round1(timeline.spAt(refCutoff)),
      doneAt,
      doneInSprint: Boolean(
        doneAt && (!sprintEndCutoff || new Date(doneAt).getTime() <= sprintEndCutoff)
      ),
      removed: !timeline.inSprintAt(refCutoff),
      timeline
    });
  }

  for (const leaf of leaves) {
    const currentSp = leaf.fields[config.storyPointsField] || 0;
    const assignee = leaf.fields.assignee;
    const devId = assignee?.accountId || 'unassigned';
    const statusCategory = leaf.fields.status?.statusCategory?.key || 'new';
    const changelog = changelogs?.[String(leaf.id)];
    const doneAt = resolveDoneAt(leaf, changelog, statusCategoryMap, sprintEndCutoff);
    const addedAt = resolveAddedAt(leaf, changelog, sprint?.name);
    const timeline = buildTimelines(leaf, changelog, sprint?.name, currentSp);

    const sp = round1(timeline.spAt(refCutoff));
    const inAtEnd = timeline.inSprintAt(refCutoff);
    const doneInSprint = Boolean(
      doneAt && (!sprintEndCutoff || new Date(doneAt).getTime() <= sprintEndCutoff)
    );
    const parent = leaf.fields.parent;

    const tracker = {
      id: leaf.id,
      key: leaf.key,
      summary: leaf.fields.summary,
      url: `${config.jiraBaseUrl}/browse/${leaf.key}`,
      type: leaf.fields.issuetype?.name || 'Sub-task',
      typeIcon: leaf.fields.issuetype?.iconUrl || null,
      status: leaf.fields.status?.name || 'Unknown',
      statusCategory,
      priority: leaf.fields.priority?.name || null,
      sp,
      devId,
      doneAt,
      addedAt,
      doneInSprint,
      // Removed mid-sprint (descoped): shows in chart history, not in totals.
      removed: !inAtEnd,
      // Still in the sprint at its end but not finished inside it.
      spilled: sprintEndCutoff ? inAtEnd && !doneInSprint : false,
      parentKey: parent?.key || null,
      parentSummary: parent?.fields?.summary || parentsByKey[parent?.key]?.fields?.summary || null,
      updated: leaf.fields.updated
    };
    allTrackers.push(tracker);

    if (!inAtEnd) continue; // descoped items don't count toward anyone's totals

    if (!devMap.has(devId)) {
      devMap.set(devId, {
        id: devId,
        name: assignee?.displayName || 'Unassigned',
        avatar: assignee?.avatarUrls?.['48x48'] || null,
        totalSP: 0,
        doneSP: 0,
        inProgressSP: 0,
        todoSP: 0,
        trackerCount: 0,
        doneCount: 0
      });
    }
    const dev = devMap.get(devId);
    dev.totalSP += sp;
    dev.trackerCount += 1;
    if (doneInSprint) {
      dev.doneSP += sp;
      dev.doneCount += 1;
    } else if (statusCategory === 'indeterminate') {
      dev.inProgressSP += sp;
    } else {
      // Includes spillover finished after the sprint ended.
      dev.todoSP += sp;
    }
  }

  const developers = [...devMap.values()]
    .map((d) => ({
      ...d,
      totalSP: round1(d.totalSP),
      doneSP: round1(d.doneSP),
      inProgressSP: round1(d.inProgressSP),
      todoSP: round1(d.todoSP),
      remainingSP: round1(d.totalSP - d.doneSP)
    }))
    // Roster is derived from this sprint's assignees only — no fixed team list.
    // Drop Unassigned when they have no SP (noise, not a participant).
    .filter((d) => d.trackerCount > 0 && (d.id !== 'unassigned' || d.totalSP > 0))
    .sort((a, b) => b.remainingSP - a.remainingSP || b.totalSP - a.totalSP);

  const burnup = buildBurnup({ sprint, boardRecords });

  const trackers = allTrackers.filter((t) => !t.removed);
  const totals = {
    totalSP: round1(developers.reduce((a, d) => a + d.totalSP, 0)),
    doneSP: round1(developers.reduce((a, d) => a + d.doneSP, 0)),
    trackerCount: trackers.length,
    doneCount: developers.reduce((a, d) => a + d.doneCount, 0)
  };
  totals.remainingSP = round1(totals.totalSP - totals.doneSP);

  return {
    mode,
    fetchedAt,
    team: team ? { key: team.key, name: team.name } : null,
    sprint: sprint
      ? {
          id: sprint.id,
          name: sprint.name,
          goal: sprint.goal || null,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          boardId: sprint.boardId,
          workingDays: burnup.workingDays.length
        }
      : null,
    totals,
    developers,
    trackers,
    burnup
  };
}

/**
 * The Burnup page mirrors Jira's board-level burnup exactly: scope and
 * completed lines are computed from non-subtask issues, using each issue's
 * estimate AS OF each day (estimate updates move the lines) and its sprint
 * membership on that day (removals drop the scope).
 */
function buildBurnup({ sprint, boardRecords }) {
  if (!sprint?.startDate || !sprint?.endDate) {
    return { days: [], workingDays: [], series: {}, developers: [], totals: null };
  }

  const startKey = toDateKey(sprint.startDate);
  const endKey = toDateKey(sprint.endDate);
  const todayKey = toDateKey(Date.now());

  // Calendar-day axis like Jira's burnup: weekends stay on the chart (as
  // shaded plateaus); only working days advance the guideline.
  const days = [];
  for (let t = new Date(`${startKey}T12:00:00Z`).getTime(); ; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    days.push(key);
    if (key >= endKey || days.length > 60) break;
  }
  const workingDays = days.filter((d) => !isWeekend(d));
  const workingDayCount = Math.max(workingDays.length, 1);

  // Board-level per-developer roster (issue assignees). Every assignee with a
  // record gets a series — including those whose items were all descoped
  // mid-sprint — so the individual charts always sum to the team chart.
  // Totals only count items still in the sprint at its end.
  const devTotals = new Map();
  for (const r of boardRecords) {
    if (!devTotals.has(r.devId)) {
      devTotals.set(r.devId, {
        id: r.devId,
        name: r.devName,
        avatar: r.avatar,
        totalSP: 0,
        doneSP: 0
      });
    }
    if (r.removed) continue;
    const d = devTotals.get(r.devId);
    d.totalSP += r.sp;
    if (r.doneInSprint) d.doneSP += r.sp;
  }
  const developers = [...devTotals.values()]
    .map((d) => ({
      ...d,
      totalSP: round1(d.totalSP),
      doneSP: round1(d.doneSP),
      remainingSP: round1(d.totalSP - d.doneSP)
    }))
    .filter((d) => d.id !== 'unassigned' || d.totalSP > 0)
    .sort((a, b) => b.remainingSP - a.remainingSP || b.totalSP - a.totalSP);

  const totals = {
    totalSP: round1(developers.reduce((a, d) => a + d.totalSP, 0)),
    doneSP: round1(developers.reduce((a, d) => a + d.doneSP, 0))
  };
  totals.remainingSP = round1(totals.totalSP - totals.doneSP);

  const series = {};
  const devList = [{ id: '__team__', totalSP: totals.totalSP }, ...developers];

  for (const dev of devList) {
    const devRecords =
      dev.id === '__team__' ? boardRecords : boardRecords.filter((r) => r.devId === dev.id);
    const total = round1(dev.totalSP);
    let workingElapsed = 0;
    const points = days.map((dayKey) => {
      const weekend = isWeekend(dayKey);
      if (!weekend) workingElapsed += 1;
      const cutoff = endOfDayUtc(dayKey);
      const future = dayKey > todayKey;

      let scopeSP = 0;
      let doneSP = 0;
      for (const r of devRecords) {
        if (future) {
          // Future days show the final known composition.
          if (!r.removed) scopeSP += r.sp;
          continue;
        }
        if (!r.timeline.inSprintAt(cutoff)) continue;
        const spThen = r.timeline.spAt(cutoff);
        scopeSP += spThen;
        if (r.doneAt && new Date(r.doneAt).getTime() <= cutoff) doneSP += spThen;
      }

      // Guideline per Jira: rises by an equal share on each WORKING day and
      // stays flat across weekends. Unrounded — per-point rounding bends the
      // rendered line.
      return {
        date: dayKey,
        weekend,
        scope: round1(scopeSP),
        ideal: (total * workingElapsed) / workingDayCount,
        burned: future ? null : round1(doneSP)
      };
    });
    series[dev.id] = points;
  }

  return { days, workingDays, todayKey, series, developers, totals };
}
