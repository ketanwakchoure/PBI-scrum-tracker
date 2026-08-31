// Jira Team[Team] field IDs (customfield_12000) for PBI teams on the PRE board.
export const TEAMS = [
  {
    key: 'iota',
    name: 'IOTA (PBI)',
    jiraTeamId: '827e555d-3cbc-4be4-a2d4-595a7b3ba5ef-1031'
  },
  {
    key: 'nexus',
    name: 'Nexus (PBI)',
    jiraTeamId: 'a5f7ecc8-36d6-4a07-b579-7a2cb71af31e'
  },
  {
    key: 'astra',
    name: 'Astra',
    jiraTeamId: '675eff01-0a49-4da1-af1d-b43cd15b5d02'
  },
  {
    key: 'blitz',
    name: 'Blitz',
    jiraTeamId: '7d20c752-9308-44cf-9197-f7faaa0049cb'
  },
  {
    key: 'all',
    name: 'All teams',
    // Aggregate pseudo-team: matches any of the real teams above.
    jiraTeamIds: [
      '827e555d-3cbc-4be4-a2d4-595a7b3ba5ef-1031',
      'a5f7ecc8-36d6-4a07-b579-7a2cb71af31e',
      '675eff01-0a49-4da1-af1d-b43cd15b5d02',
      '7d20c752-9308-44cf-9197-f7faaa0049cb'
    ]
  }
];

export const DEFAULT_TEAM_KEY = 'iota';

export function resolveTeam(key) {
  return TEAMS.find((t) => t.key === key) || TEAMS.find((t) => t.key === DEFAULT_TEAM_KEY);
}

// JQL clause selecting this team's issues (handles the aggregate pseudo-team).
export function teamJql(team) {
  return team.jiraTeamIds
    ? `"Team[Team]" in (${team.jiraTeamIds.join(', ')})`
    : `"Team[Team]" = ${team.jiraTeamId}`;
}

// Does a Team-field value from an issue belong to this (pseudo-)team?
export function matchesTeam(fieldValue, team) {
  if (!fieldValue) return false;
  if (team.jiraTeamIds) return team.jiraTeamIds.includes(fieldValue.id);
  return fieldValue.id === team.jiraTeamId || fieldValue.name === team.name;
}
