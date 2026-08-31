import { useState } from 'react';
import { useEpics } from '../api.js';

function SegmentBar({ node }) {
  const total = node.totalSP || 1;
  return (
    <div
      className="segbar"
      title={`Done ${node.doneSP} · In progress ${node.inProgressSP} · To do ${node.todoSP}`}
    >
      <div className="seg done" style={{ width: `${(node.doneSP / total) * 100}%` }} />
      <div className="seg inprogress" style={{ width: `${(node.inProgressSP / total) * 100}%` }} />
      <div className="seg todo" style={{ width: `${(node.todoSP / total) * 100}%` }} />
    </div>
  );
}

function SpFraction({ node }) {
  return (
    <div className="dev-remaining">
      <div className="dev-remaining-value">
        {node.remainingSP}
        <span className="dev-remaining-denom">/{node.totalSP}</span>
      </div>
      <div className="dev-remaining-label">SP to burn</div>
    </div>
  );
}

function SubtaskTable({ subtasks }) {
  return (
    <table className="tracker-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Subtask</th>
          <th>Status</th>
          <th>SP</th>
        </tr>
      </thead>
      <tbody>
        {subtasks.map((s) => (
          <tr key={s.key} className={s.statusCategory === 'done' ? 'row-done' : ''}>
            <td className="mono">
              <a href={s.url} target="_blank" rel="noreferrer" className="issue-link">
                {s.key}
              </a>
            </td>
            <td className="tracker-summary">
              <span className="tracker-type">{s.type}</span>
              {s.summary}
              {s.assignee && <span className="parent-ref">{s.assignee}</span>}
            </td>
            <td>
              <span className={`pill ${s.statusCategory}`}>{s.status}</span>
            </td>
            <td className="sp-cell mono">{s.sp || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TaskRow({ task, isOpen, onToggle }) {
  return (
    <div className={`epic-task${isOpen ? ' open' : ''}`}>
      <button type="button" className="dev-head task-head" onClick={onToggle}>
        <div className="task-key mono">
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="issue-link"
            onClick={(e) => e.stopPropagation()}
          >
            {task.key}
          </a>
        </div>
        <div className="dev-name-block task-name-block">
          <div className="task-summary">
            <span className="tracker-type">{task.type}</span>
            {task.summary}
          </div>
          <div className="dev-meta">
            <span className={`pill ${task.statusCategory}`}>{task.status}</span>
            {task.assignee && <span className="task-assignee"> {task.assignee}</span>}
            {' · '}
            {task.subtasks.length} subtask{task.subtasks.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="dev-bar-block">
          <SegmentBar node={task} />
          <div className="dev-bar-legend">
            <span className="lg done">{task.doneSP} done</span>
            <span className="lg inprogress">{task.inProgressSP} in progress</span>
            <span className="lg todo">{task.todoSP} to do</span>
          </div>
        </div>
        <SpFraction node={task} />
        <div className={`chevron${isOpen ? ' up' : ''}`}>▾</div>
      </button>
      {isOpen && task.subtasks.length > 0 && (
        <div className="tracker-table-wrap">
          <SubtaskTable subtasks={task.subtasks} />
        </div>
      )}
      {isOpen && task.subtasks.length === 0 && (
        <div className="tracker-table-wrap epic-empty">
          No subtasks — the {task.sp || 0} SP live on this item itself.
        </div>
      )}
    </div>
  );
}

export default function Epics({ teamKey, release }) {
  const [openEpics, setOpenEpics] = useState(() => new Set());
  const [openTasks, setOpenTasks] = useState(() => new Set());

  const { data, error, loading } = useEpics(teamKey, release);

  const toggle = (setter) => (key) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleEpic = toggle(setOpenEpics);
  const toggleTask = toggle(setOpenTasks);

  if (!release) return <div className="loading">Loading releases…</div>;

  return (
    <>
      {data && (
        <section className="epic-toolbar">
          <h1 className="epic-release-title">{release}</h1>
          <div className="epic-totals">
            <span className="lg done">{data.totals.doneSP} burned</span>
            <span className="lg inprogress">{data.totals.inProgressSP} in progress</span>
            <span className="lg todo">{data.totals.todoSP} to do</span>
            <span className="epic-totals-total">
              {data.totals.remainingSP}/{data.totals.totalSP} SP to burn
            </span>
          </div>
        </section>
      )}

      {error && <div className="error-banner">Failed to load epics: {error}</div>}
      {loading && <div className="loading">Loading epics…</div>}

      {data && (
        <section className="dev-list">
          {data.epics.map((epic) => {
            const isOpen = openEpics.has(epic.key);
            return (
              <div key={epic.key} className={`dev-card${isOpen ? ' open' : ''}`}>
                <button type="button" className="dev-head" onClick={() => toggleEpic(epic.key)}>
                  <div className="task-key mono">
                    <a
                      href={epic.url}
                      target="_blank"
                      rel="noreferrer"
                      className="issue-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {epic.key}
                    </a>
                  </div>
                  <div className="dev-name-block epic-name-block">
                    <div className="dev-name">{epic.summary}</div>
                    <div className="dev-meta">
                      <span className={`pill ${epic.statusCategory}`}>{epic.status}</span>
                      {' · '}
                      {epic.taskCount} task{epic.taskCount !== 1 ? 's' : ''} · {epic.doneTaskCount} done
                    </div>
                  </div>
                  <div className="dev-bar-block">
                    <SegmentBar node={epic} />
                    <div className="dev-bar-legend">
                      <span className="lg done">{epic.doneSP} done</span>
                      <span className="lg inprogress">{epic.inProgressSP} in progress</span>
                      <span className="lg todo">{epic.todoSP} to do</span>
                    </div>
                  </div>
                  <SpFraction node={epic} />
                  <div className={`chevron${isOpen ? ' up' : ''}`}>▾</div>
                </button>
                {isOpen && (
                  <div className="epic-tasks">
                    {epic.tasks.map((task) => (
                      <TaskRow
                        key={task.key}
                        task={task}
                        isOpen={openTasks.has(task.key)}
                        onToggle={() => toggleTask(task.key)}
                      />
                    ))}
                    {!epic.tasks.length && <div className="epic-empty">No child issues.</div>}
                  </div>
                )}
              </div>
            );
          })}
          {!data.epics.length && <div className="loading">No epics in this release for this team.</div>}
        </section>
      )}
    </>
  );
}
