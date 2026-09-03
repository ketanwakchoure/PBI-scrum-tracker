// Backlog grooming: sprint-wide tracker tree with inline SP updates and
// subtask creation. Issue types and their required fields come from Jira's
// create-metadata, so the UI can prompt for whatever Jira actually requires.
import config from './config.js';
import { jiraRequest, searchIssues } from './jira.js';
import { teamJql } from './teams.js';

const FIELDS = [
  'summary',
  'issuetype',
  'status',
  'assignee',
  'parent',
  'components',
  config.storyPointsField
];

function shape(issue) {
  return {
    key: issue.key,
    summary: issue.fields.summary || '',
    type: issue.fields.issuetype?.name || '',
    subtask: Boolean(issue.fields.issuetype?.subtask),
    status: issue.fields.status?.name || '',
    statusCategory: issue.fields.status?.statusCategory?.key || 'new',
    assignee: issue.fields.assignee?.displayName || null,
    assigneeId: issue.fields.assignee?.accountId || null,
    components: (issue.fields.components || []).map((c) => ({ id: c.id, name: c.name })),
    storyPoints: issue.fields[config.storyPointsField] ?? null,
    parentKey: issue.fields.parent?.key || null
  };
}

// ── Create-metadata: which subtask types exist, and what each requires ──

// Fields we fill automatically when creating a subtask; anything else that
// Jira marks required must be prompted for in the UI.
const AUTO_FILLED = new Set([
  'project',
  'issuetype',
  'parent',
  'summary',
  'components',
  config.storyPointsField,
  'reporter'
]);

let createMetaCache = { data: null, at: 0 };
let assignableCache = { data: null, at: 0 };

// People who can be assigned issues in the project (cached: it changes rarely).
async function getAssignableUsers() {
  if (assignableCache.data && Date.now() - assignableCache.at < 6 * 60 * 60 * 1000) {
    return assignableCache.data;
  }
  const users = [];
  for (let startAt = 0; ; startAt += 50) {
    const page = await jiraRequest(
      'GET',
      `/rest/api/3/user/assignable/search?project=${config.projectKey}&startAt=${startAt}&maxResults=50`
    );
    users.push(...page);
    if (page.length < 50) break;
  }
  const shaped = users
    .filter((u) => u.active && u.accountType === 'atlassian')
    .map((u) => ({ id: u.accountId, name: u.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assignableCache = { data: shaped, at: Date.now() };
  return shaped;
}

export async function getSubtaskCreateMeta() {
  if (createMetaCache.data && Date.now() - createMetaCache.at < 6 * 60 * 60 * 1000) {
    return createMetaCache.data;
  }
  const typesRes = await jiraRequest(
    'GET',
    `/rest/api/3/issue/createmeta/${config.projectKey}/issuetypes?maxResults=200`
  );
  const subtaskTypes = (typesRes.issueTypes || typesRes.values || []).filter((t) => t.subtask);

  const types = await Promise.all(
    subtaskTypes.map(async (t) => {
      const fieldsRes = await jiraRequest(
        'GET',
        `/rest/api/3/issue/createmeta/${config.projectKey}/issuetypes/${t.id}?maxResults=200`
      );
      const fields = fieldsRes.fields || fieldsRes.values || [];
      const requiredExtras = fields
        .filter(
          (f) =>
            f.required &&
            !f.hasDefaultValue &&
            !AUTO_FILLED.has(f.fieldId || f.key)
        )
        .map((f) => ({
          key: f.fieldId || f.key,
          name: f.name,
          schemaType: f.schema?.type || 'string',
          allowedValues: (f.allowedValues || []).map((v) => ({
            id: v.id,
            label: v.value || v.name || String(v.id)
          }))
        }));
      return { id: t.id, name: t.name, requiredExtras };
    })
  );
  createMetaCache = { data: types, at: Date.now() };
  return types;
}

// ── Sprint tracker tree ──

export async function loadSprintTrackers(team, sprintId) {
  const sprintClause = sprintId ? `sprint = ${Number(sprintId)}` : 'sprint in openSprints()';
  const sprintIssues = await searchIssues(`${sprintClause} AND ${teamJql(team)}`, FIELDS);

  const parents = sprintIssues.filter((i) => !i.fields.issuetype?.subtask);
  // The sprint query can miss subtasks that lack the team field: fetch every
  // child of the sprint's parents so the tree is complete.
  const children = [];
  const parentKeys = parents.map((p) => p.key);
  for (let i = 0; i < parentKeys.length; i += 50) {
    const chunk = parentKeys.slice(i, i + 50);
    children.push(...(await searchIssues(`parent in (${chunk.join(',')})`, FIELDS)));
  }

  const byParent = {};
  for (const child of children) {
    const p = child.fields.parent?.key;
    if (p) (byParent[p] = byParent[p] || []).push(shape(child));
  }

  const [types, componentsRes, assignableUsers] = await Promise.all([
    getSubtaskCreateMeta(),
    jiraRequest('GET', `/rest/api/3/project/${config.projectKey}/components`),
    getAssignableUsers()
  ]);

  const trackers = parents
    .map((p) => ({
      ...shape(p),
      subtasks: (byParent[p.key] || []).sort((a, b) => a.key.localeCompare(b.key))
    }))
    .sort(
      (a, b) =>
        (a.statusCategory === 'done') - (b.statusCategory === 'done') ||
        a.key.localeCompare(b.key)
    );

  return {
    fetchedAt: new Date().toISOString(),
    team: { key: team.key, name: team.name },
    trackers,
    subtaskTypes: types,
    components: componentsRes.map((c) => ({ id: c.id, name: c.name })),
    assignableUsers,
    jiraBaseUrl: config.jiraBaseUrl
  };
}

// ── Writes ──

function coerceFieldValue(schemaType, value, allowedValues) {
  if (schemaType === 'number') return Number(value);
  if (schemaType === 'option') return { id: String(value) };
  if (schemaType === 'array') {
    const arr = Array.isArray(value) ? value : [value];
    return arr.map((v) => (allowedValues?.length ? { id: String(v) } : String(v)));
  }
  if (schemaType === 'user') return { accountId: String(value) };
  if (schemaType === 'priority' || schemaType === 'issuetype') return { id: String(value) };
  return value;
}

export async function applyGrooming({ creates = [], spUpdates = [] }, meta) {
  const createResults = [];
  for (const c of creates) {
    try {
      const typeMeta = (meta || []).find((t) => t.id === String(c.issueTypeId));
      const fields = {
        project: { key: config.projectKey },
        parent: { key: c.parentKey },
        issuetype: { id: String(c.issueTypeId) },
        summary: c.summary,
        components: (c.componentIds || []).map((id) => ({ id }))
      };
      if (c.storyPoints !== null && c.storyPoints !== undefined && c.storyPoints !== '') {
        fields[config.storyPointsField] = Number(c.storyPoints);
      }
      if (c.assigneeId) {
        fields.assignee = { accountId: String(c.assigneeId) };
      }
      for (const [key, value] of Object.entries(c.extraFields || {})) {
        if (value === '' || value === null || value === undefined) continue;
        const fieldMeta = typeMeta?.requiredExtras?.find((f) => f.key === key);
        fields[key] = coerceFieldValue(
          fieldMeta?.schemaType || 'string',
          value,
          fieldMeta?.allowedValues
        );
      }
      const data = await jiraRequest('POST', '/rest/api/3/issue', { fields });
      createResults.push({
        parentKey: c.parentKey,
        typeName: typeMeta?.name || c.issueTypeId,
        success: true,
        createdKey: data.key,
        createdUrl: `${config.jiraBaseUrl}/browse/${data.key}`
      });
    } catch (err) {
      createResults.push({
        parentKey: c.parentKey,
        typeName: c.issueTypeId,
        success: false,
        error: err.message
      });
    }
  }

  const spResults = [];
  for (const upd of spUpdates) {
    try {
      await jiraRequest('PUT', `/rest/api/3/issue/${upd.issueKey}`, {
        fields: { [config.storyPointsField]: Number(upd.storyPoints) }
      });
      spResults.push({ issueKey: upd.issueKey, success: true });
    } catch (err) {
      spResults.push({ issueKey: upd.issueKey, success: false, error: err.message });
    }
  }

  return { createResults, spResults };
}
