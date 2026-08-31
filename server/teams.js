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
  }
];

export const DEFAULT_TEAM_KEY = 'iota';

export function resolveTeam(key) {
  return TEAMS.find((t) => t.key === key) || TEAMS.find((t) => t.key === DEFAULT_TEAM_KEY);
}
