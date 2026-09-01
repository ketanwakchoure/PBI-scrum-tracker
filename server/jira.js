import config from './config.js';
import { teamJql } from './teams.js';

const authHeader = () =>
  'Basic ' + Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');

export async function jiraRequest(method, apiPath, body) {
  const res = await fetch(`${config.jiraBaseUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${method} ${apiPath} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  // Writes like PUT /issue return 204 No Content — don't JSON-parse an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'assignee',
  'parent',
  'priority',
  'created',
  'updated',
  'resolutiondate',
  'statuscategorychangedate',
  config.storyPointsField,
  config.sprintField,
  config.teamField
];

export async function searchIssues(jql, fields) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await jiraRequest('POST', '/rest/api/3/search/jql', {
      jql,
      fields,
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {})
    });
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);
  return issues;
}

export async function fetchSprintIssues(sprintId, team) {
  const sprintClause = sprintId ? `sprint = ${Number(sprintId)}` : 'sprint in openSprints()';
  return searchIssues(`${sprintClause} AND ${teamJql(team)}`, ISSUE_FIELDS);
}

// All sprints on the board (closed + active + future), newest first.
export async function fetchBoardSprints() {
  const sprints = [];
  let startAt = 0;
  for (;;) {
    const page = await jiraRequest(
      'GET',
      `/rest/agile/1.0/board/${config.boardId}/sprint?startAt=${startAt}&maxResults=50`
    );
    sprints.push(...(page.values || []));
    if (page.isLast || !page.values?.length) break;
    startAt += page.values.length;
  }
  return sprints
    .map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate || null,
      endDate: s.endDate || null,
      goal: s.goal || null
    }))
    .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
}

// Map of status name (lowercase) -> status category key ('new'|'indeterminate'|'done')
export async function fetchStatusCategoryMap() {
  const statuses = await jiraRequest('GET', '/rest/api/3/status');
  const map = {};
  for (const s of statuses) {
    if (s.name && s.statusCategory) map[s.name.toLowerCase()] = s.statusCategory.key;
  }
  return map;
}

// Returns { [issueId]: [entry] } where entry is one of
//   { field: 'status', created, fromStatus, toStatus }   (status transitions)
//   { field: 'sprint', created, toSprints }               (sprint membership changes)
//   { field: 'sp', created, from, to }                    (estimate updates)
export async function fetchIssueChangelogs(issueIds) {
  const result = {};
  const batchSize = 100;
  for (let i = 0; i < issueIds.length; i += batchSize) {
    const batch = issueIds.slice(i, i + batchSize);
    let nextPageToken;
    do {
      const page = await jiraRequest('POST', '/rest/api/3/changelog/bulkfetch', {
        issueIdsOrKeys: batch,
        fieldIds: ['status', config.sprintField, config.storyPointsField],
        maxResults: 1000,
        ...(nextPageToken ? { nextPageToken } : {})
      });
      for (const entry of page.issueChangeLogs || []) {
        const id = String(entry.issueId);
        result[id] = result[id] || [];
        for (const history of entry.changeHistories || []) {
          // bulkfetch may return epoch millis (number/string) or ISO date
          const raw = history.created;
          const created = new Date(!isNaN(Number(raw)) ? Number(raw) : raw).toISOString();
          for (const item of history.items || []) {
            if (item.field === 'status') {
              result[id].push({
                field: 'status',
                created,
                fromStatus: item.fromString,
                toStatus: item.toString
              });
            } else if (item.field === 'Sprint' || item.fieldId === config.sprintField) {
              result[id].push({
                field: 'sprint',
                created,
                fromSprints: item.fromString || '',
                toSprints: item.toString || ''
              });
            } else if (item.fieldId === config.storyPointsField) {
              result[id].push({
                field: 'sp',
                created,
                from: item.fromString,
                to: item.toString
              });
            }
          }
        }
      }
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
  }
  return result;
}
