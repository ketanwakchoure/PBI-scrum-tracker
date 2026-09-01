import { useMemo, useState } from 'react';

// One-step backlog grooming: paste the Jira keys being groomed, edit the SP
// breakdown / subtasks inline, and apply everything to Jira with one click.

const CATEGORIES = ['analysis', 'dev', 'qa', 'codeReview'];

function parseSp(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function defaultRows(item, subtaskTypes) {
  const rows = {};
  const description = item.parent?.summary || item.jiraKey;
  for (const cat of CATEGORIES) {
    const label = subtaskTypes[cat]?.label || cat;
    rows[cat] = {
      enabled: false,
      sp: '',
      summary: `${label}: ${item.jiraKey} - ${description}`,
      componentIds: item.parent?.components?.map((c) => c.id) || []
    };
  }
  return rows;
}

function ComponentPicker({ components, selected, onChange }) {
  return (
    <details className="component-picker">
      <summary>
        {selected.length
          ? components
              .filter((c) => selected.includes(c.id))
              .map((c) => c.name)
              .join(', ') || `${selected.length} selected`
          : 'No components'}
      </summary>
      <div className="component-menu">
        {components.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id)
                )
              }
            />
            {c.name}
          </label>
        ))}
      </div>
    </details>
  );
}

export default function Grooming() {
  const [keysInput, setKeysInput] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState(null);

  // Edit state, keyed by item id.
  const [modes, setModes] = useState({}); // 'subtasks' | 'parent-sp'
  const [rows, setRows] = useState({}); // itemId -> cat -> {enabled, sp, summary, componentIds}
  const [parentSp, setParentSp] = useState({}); // itemId -> string

  const load = async () => {
    if (!keysInput.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(`/api/grooming/items?keys=${encodeURIComponent(keysInput)}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
      const initRows = {};
      for (const item of body.items) initRows[item.id] = defaultRows(item, body.subtaskTypes);
      setRows(initRows);
      setModes({});
      setParentSp({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateRow = (itemId, cat, patch) =>
    setRows((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], [cat]: { ...prev[itemId][cat], ...patch } }
    }));

  const items = data?.items || [];
  const subtaskTypes = data?.subtaskTypes || {};

  const pending = useMemo(() => {
    const subtasks = [];
    const parentSpUpdates = [];
    for (const item of items) {
      if (item.error) continue;
      if ((modes[item.id] || 'subtasks') === 'parent-sp') {
        const sp = parseSp(parentSp[item.id]);
        if (sp !== null && sp > 0) parentSpUpdates.push({ issueKey: item.jiraKey, storyPoints: sp });
      } else {
        for (const cat of CATEGORIES) {
          const row = rows[item.id]?.[cat];
          if (row?.enabled) {
            subtasks.push({
              parentKey: item.jiraKey,
              category: cat,
              summary: row.summary,
              storyPoints: parseSp(row.sp),
              componentIds: row.componentIds
            });
          }
        }
      }
    }
    return { subtasks, parentSpUpdates };
  }, [items, modes, rows, parentSp]);

  const pendingCount = pending.subtasks.length + pending.parentSpUpdates.length;

  const apply = async () => {
    if (!pendingCount) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/grooming/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending)
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setResults(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  };

  const resultsFor = (item) => ({
    created: (results?.createResults || []).filter((r) => r.parentKey === item.jiraKey),
    sp: (results?.parentSpResults || []).filter((r) => r.issueKey === item.jiraKey)
  });

  return (
    <>
      <section className="epic-toolbar">
        <div className="grooming-loader">
          <input
            type="text"
            className="grooming-keys"
            placeholder="Jira keys to groom, e.g. PRE-27712 PRE-27725 PRE-27678"
            value={keysInput}
            onChange={(e) => setKeysInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <button type="button" className="btn" onClick={load} disabled={loading || !keysInput.trim()}>
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
        {data && (
          <div className="grooming-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={apply}
              disabled={applying || !pendingCount}
              title="Creates the enabled subtasks and applies parent SP updates in Jira"
            >
              {applying ? 'Applying…' : `Apply to Jira (${pendingCount})`}
            </button>
          </div>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}
      {results && (
        <div className="grooming-summary">
          Created {results.createResults.filter((r) => r.success).length}/
          {results.createResults.length} subtasks
          {results.parentSpResults.length > 0 &&
            ` · updated SP on ${results.parentSpResults.filter((r) => r.success).length}/${results.parentSpResults.length} parents`}
          {' · '}
          <button type="button" className="link-btn" onClick={load}>
            reload items
          </button>
        </div>
      )}

      {!data && !loading && (
        <div className="loading">
          Paste the Jira keys for this grooming session above — details, existing subtasks, and
          components load in one go.
        </div>
      )}

      <section className="dev-list">
        {items.map((item) => {
          const mode = modes[item.id] || 'subtasks';
          const itemResults = resultsFor(item);
          return (
            <div key={item.id} className="dev-card open grooming-card">
              <div className="grooming-head">
                <div className="task-key mono">
                  <a
                    href={`${data.jiraBaseUrl}/browse/${item.jiraKey}`}
                    target="_blank"
                    rel="noreferrer"
                    className="issue-link"
                  >
                    {item.jiraKey}
                  </a>
                </div>
                {item.error ? (
                  <div className="grooming-title">
                    <div className="err-text">{item.error}</div>
                  </div>
                ) : (
                  <>
                    <div className="grooming-title">
                      <div className="dev-name">{item.parent.summary}</div>
                      <div className="dev-meta">
                        <span className="tracker-type">{item.parent.issueTypeName}</span>
                        {` ${item.parent.status}`}
                        {item.parent.assignee && ` · ${item.parent.assignee}`}
                        {item.parent.storyPoints != null && ` · parent SP: ${item.parent.storyPoints}`}
                      </div>
                      {item.existingSubtasks.length > 0 && (
                        <div className="grooming-existing">
                          Already has {item.existingSubtasks.length} subtask
                          {item.existingSubtasks.length !== 1 ? 's' : ''}:{' '}
                          {item.existingSubtasks
                            .map((s) => `${s.key} (${s.storyPoints ?? '—'})`)
                            .join(', ')}
                        </div>
                      )}
                    </div>
                    <div className="grooming-mode">
                      <button
                        type="button"
                        className={`chip${mode === 'subtasks' ? ' active' : ''}`}
                        onClick={() => setModes((p) => ({ ...p, [item.id]: 'subtasks' }))}
                      >
                        Subtasks
                      </button>
                      <button
                        type="button"
                        className={`chip${mode === 'parent-sp' ? ' active' : ''}`}
                        onClick={() => setModes((p) => ({ ...p, [item.id]: 'parent-sp' }))}
                      >
                        Parent SP
                      </button>
                    </div>
                  </>
                )}
              </div>

              {!item.error &&
                (mode === 'parent-sp' ? (
                  <div className="grooming-rows">
                    <div className="grooming-row">
                      <span className="grooming-cat">Parent SP</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        className="grooming-sp"
                        placeholder="SP"
                        value={parentSp[item.id] ?? ''}
                        onChange={(e) => setParentSp((p) => ({ ...p, [item.id]: e.target.value }))}
                      />
                      <span className="dev-meta">sets {item.jiraKey}'s story points directly</span>
                    </div>
                  </div>
                ) : (
                  <div className="grooming-rows">
                    {CATEGORIES.map((cat) => {
                      const row = rows[item.id]?.[cat];
                      if (!row) return null;
                      return (
                        <div key={cat} className={`grooming-row${row.enabled ? '' : ' disabled'}`}>
                          <label className="grooming-enable">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={(e) =>
                                updateRow(item.id, cat, { enabled: e.target.checked })
                              }
                            />
                            <span className="grooming-cat">{subtaskTypes[cat]?.label || cat}</span>
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            className="grooming-sp"
                            placeholder="SP"
                            value={row.sp}
                            onChange={(e) =>
                              updateRow(item.id, cat, {
                                sp: e.target.value,
                                enabled: parseSp(e.target.value) > 0
                              })
                            }
                          />
                          <input
                            type="text"
                            className="grooming-summary"
                            value={row.summary}
                            onChange={(e) => updateRow(item.id, cat, { summary: e.target.value })}
                          />
                          <ComponentPicker
                            components={data.components}
                            selected={row.componentIds}
                            onChange={(componentIds) => updateRow(item.id, cat, { componentIds })}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}

              {(itemResults.created.length > 0 || itemResults.sp.length > 0) && (
                <div className="grooming-results">
                  {itemResults.created.map((r) => (
                    <span
                      key={`${r.category}-${r.createdKey || r.error}`}
                      className={r.success ? 'ok-text' : 'err-text'}
                    >
                      {r.success ? (
                        <a
                          className="issue-link"
                          href={r.createdUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {r.createdKey}
                        </a>
                      ) : (
                        `${subtaskTypes[r.category]?.label || r.category}: ${r.error}`
                      )}
                    </span>
                  ))}
                  {itemResults.sp.map((r) => (
                    <span key={r.issueKey} className={r.success ? 'ok-text' : 'err-text'}>
                      {r.success ? 'parent SP updated' : `SP update failed: ${r.error}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}
