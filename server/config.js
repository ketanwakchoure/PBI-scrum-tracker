import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const config = {
  port: Number(process.env.PORT) || 4600,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS) || 300000,
  // Closed sprints are effectively immutable; cache them much longer.
  closedCacheTtlMs: Number(process.env.CLOSED_CACHE_TTL_MS) || 1800000,
  jiraBaseUrl: process.env.JIRA_BASE_URL || 'https://celigo.atlassian.net',
  jiraEmail: process.env.JIRA_EMAIL || '',
  jiraApiToken: process.env.JIRA_API_TOKEN || '',
  iotaTeamId: process.env.IOTA_TEAM_ID || '827e555d-3cbc-4be4-a2d4-595a7b3ba5ef-1031',
  boardId: Number(process.env.JIRA_BOARD_ID) || 1536,
  projectKey: process.env.JIRA_PROJECT_KEY || 'PRE',
  storyPointsField: process.env.STORY_POINTS_FIELD || 'customfield_10102',
  sprintField: process.env.SPRINT_FIELD || 'customfield_10105',
  teamField: process.env.TEAM_FIELD || 'customfield_12000',
  snapshotPath: path.join(__dirname, 'data', 'snapshot.json')
};

config.liveMode = Boolean(config.jiraEmail && config.jiraApiToken);

export default config;
