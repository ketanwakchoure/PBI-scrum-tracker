// Backlog grooming: enrich a set of Jira issues for a grooming session and
// apply SP/subtask changes back to Jira. Items are entered by key — no
// external sources.
import config from './config.js';
import { jiraRequest } from './jira.js';

// Jira subtask type mapping for the PRE project.
export const SUBTASK_TYPES = {
  analysis: { id: '12550', name: 'Analysis', label: 'Analysis' },
  dev: { id: '10437', name: 'Code', label: 'Dev' },
  qa: { id: '12552', name: 'Manual test execution', label: 'QA' },
  codeReview: { id: '12451', name: 'Review', label: 'Code Review' }
};

const JIRA_KEY_PATTERN = /(?:PRE|IO|CIP|CLOUDOPS)-\d+/gi;

export function parseKeys(input) {
  const matches = String(input || '').toUpperCase().match(JIRA_KEY_PATTERN) || [];
  return [...new Set(matches)];
}

async function getIssueBasic(key) {
  const fields = `summary,issuetype,components,assignee,status,${config.storyPointsField}`;
  const data = await jiraRequest('GET', `/rest/api/3/issue/${key}?fields=${fields}`);
  return {
    key: data.key,
    summary: data.fields.summary || '',
    issueTypeName: data.fields.issuetype?.name || '',
    status: data.fields.status?.name || '',
    assignee: data.fields.assignee?.displayName || null,
    components: (data.fields.components || []).map((c) => ({ id: c.id, name: c.name })),
    storyPoints: data.fields[config.storyPointsField] ?? null
  };
}

async function getExistingSubtasks(parentKey) {
  const jql = encodeURIComponent(`parent = ${parentKey} ORDER BY issuetype, key`);
  const fields = `summary,issuetype,status,assignee,${config.storyPointsField}`;
  const data = await jiraRequest(
    'GET',
    `/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`
  );
  return (data.issues || []).map((issue) => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    issueTypeName: issue.fields.issuetype?.name || '',
    status: issue.fields.status?.name || '',
    storyPoints: issue.fields[config.storyPointsField] ?? null,
    assignee: issue.fields.assignee?.displayName || 'Unassigned'
  }));
}

// One call returns everything the grooming screen needs for the given keys.
export async function loadGroomingItems(keys) {
  const [components, items] = await Promise.all([
    jiraRequest('GET', `/rest/api/3/project/${config.projectKey}/components`).then((data) =>
      data.map((c) => ({ id: c.id, name: c.name }))
    ),
    Promise.all(
      keys.map(async (key) => {
        try {
          const [parent, existingSubtasks] = await Promise.all([
            getIssueBasic(key),
            getExistingSubtasks(key)
          ]);
          return { id: key, jiraKey: key, parent, existingSubtasks };
        } catch (err) {
          return { id: key, jiraKey: key, error: err.message, existingSubtasks: [] };
        }
      })
    )
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    items,
    components,
    subtaskTypes: SUBTASK_TYPES,
    jiraBaseUrl: config.jiraBaseUrl
  };
}

// ── Jira writes ──

export async function applyGrooming({ subtasks = [], parentSpUpdates = [] }) {
  const createResults = [];
  for (const sub of subtasks) {
    const typeInfo = SUBTASK_TYPES[sub.category];
    if (!typeInfo) {
      createResults.push({
        parentKey: sub.parentKey,
        category: sub.category,
        success: false,
        error: `Unknown subtask category: ${sub.category}`
      });
      continue;
    }
    try {
      const fields = {
        project: { key: config.projectKey },
        parent: { key: sub.parentKey },
        issuetype: { id: typeInfo.id },
        summary: sub.summary,
        components: (sub.componentIds || []).map((id) => ({ id }))
      };
      if (sub.storyPoints !== null && sub.storyPoints !== undefined) {
        fields[config.storyPointsField] = sub.storyPoints;
      }
      const data = await jiraRequest('POST', '/rest/api/3/issue', { fields });
      createResults.push({
        parentKey: sub.parentKey,
        category: sub.category,
        success: true,
        createdKey: data.key,
        createdUrl: `${config.jiraBaseUrl}/browse/${data.key}`
      });
    } catch (err) {
      createResults.push({
        parentKey: sub.parentKey,
        category: sub.category,
        success: false,
        error: err.message
      });
    }
  }

  const parentSpResults = [];
  for (const upd of parentSpUpdates) {
    try {
      await jiraRequest('PUT', `/rest/api/3/issue/${upd.issueKey}`, {
        fields: { [config.storyPointsField]: upd.storyPoints }
      });
      parentSpResults.push({ issueKey: upd.issueKey, success: true });
    } catch (err) {
      parentSpResults.push({ issueKey: upd.issueKey, success: false, error: err.message });
    }
  }

  return { createResults, parentSpResults };
}
