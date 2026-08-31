# PBI Scrum Tracker

Web utility for PBI teams (IOTA, Nexus, Astra) showing, for a selected sprint:

1. **Sprint Overview** — story points each developer still has to burn (counted at
   child/subtask level) plus the trackers assigned to them.
2. **Burnup** — per-developer (and whole-team) burnup charts over the sprint's
   working days (weekends excluded).

## Run

```bash
npm install
npm run dev
```

- Client: http://localhost:4601
- API: http://localhost:4600/api/sprint

## Data modes

| Mode | When | Freshness |
|---|---|---|
| `live` (recommended) | `JIRA_EMAIL` + `JIRA_API_TOKEN` set in `.env` | Fetched from Jira on load, cached 5 min; changelog-accurate burn dates; full sprint picker |
| `snapshot` | No credentials, but a local `server/data/snapshot.json` exists | Static local fixture (gitignored — contains raw Jira data, never commit it) |

To enable live mode: copy `.env.example` to `.env`, create an API token at
<https://id.atlassian.com/manage-profile/security/api-tokens>, fill in both keys,
and restart. Never commit `.env`.

## How the numbers are computed

- Scope: JQL `sprint = <id> AND "Team[Team]" = <selected team id>` on
  celigo.atlassian.net (project PRE, board 1536). The top-bar pickers select
  team (IOTA / Nexus / Astra) and any board sprint. The full sprint list
  (closed / active / future) requires live mode.
- **Leaf level**: SP is counted on every subtask (Automation, Review, Code, …)
  PLUS parent-level items (Tech design, Spike, Task, Bug, …) that have no
  subtasks. Parents with subtasks carry a rollup of their children's SP, so
  counting both would double-count.
- Story points field: `customfield_10102`. Team field: `customfield_12000`.
  Sprint field: `customfield_10105`. All overridable via `.env`.
- Burned = SP of leaf issues whose status category is Done. Remaining = total − burned.
- The burnup axis contains only working days (Sat/Sun excluded); weekend
  completions roll into the following Monday's point. Day buckets use IST.
  In live mode the done-date comes from the status changelog; in snapshot mode
  from `resolutiondate`/`statuscategorychangedate`.
