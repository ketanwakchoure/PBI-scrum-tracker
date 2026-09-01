import { useCallback, useEffect, useMemo, useState } from 'react';

// Sprint grooming: every tracker of the selected team+sprint, expandable to
// its subtasks (two levels). Story points are editable inline on any tracker,
// new subtasks can be added with the types Jira supports (required fields are
// prompted from Jira's create-metadata), and one Apply pushes everything.

function parseSp(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function SpInput({ original, value, onChange }) {
  const dirty = value !== undefined && parseSp(value) !== (original ?? null);
  return (
    <input
      type="number"
      step="0.1"
      min="0"
      className={`grooming-sp${dirty ? ' dirty' : ''}`}
      placeholder="SP"
      value={value !== undefined ? value : original ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      title={dirty ? `Will update (was ${original ?? 'unset'})` : 'Story points'}
    />
  );
}

function RequiredFieldInput({ field, value, onChange }) {
  if (field.allowedValues.length) {
    return (
      <select
        className="grooming-sp grooming-required"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{field.name}…</option>
        {field.allowedValues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.schemaType === 'number' ? 'number' : 'text'}
      className="grooming-summary grooming-required"
      placeholder={`${field.name} (required)`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NewSubtaskRow({ draft, types, components, onChange, onRemove }) {
  const typeMeta = types.find((t) => t.id === draft.issueTypeId);
  return (
    <div className="grooming-row new-subtask">
      <select
        className="grooming-type"
        value={draft.issueTypeId}
        onChange={(e) => onChange({ issueTypeId: e.target.value, extraFields: {} })}
      >
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        step="0.1"
        min="0"
        className="grooming-sp"
        placeholder="SP"
        value={draft.storyPoints}
        onChange={(e) => onChange({ storyPoints: e.target.value })}
      />
      <input
        type="text"
        className="grooming-summary"
        value={draft.summary}
        onChange={(e) => onChange({ summary: e.target.value })}
      />
      {(typeMeta?.requiredExtras || []).map((f) => (
        <RequiredFieldInput
          key={f.key}
          field={f}
          value={draft.extraFields[f.key]}
          onChange={(v) => onChange({ extraFields: { ...draft.extraFields, [f.key]: v } })}
        />
      ))}
      <button type="button" className="link-btn" onClick={onRemove}>
        remove
      </button>
    </div>
  );
}

export default function Grooming({ teamKey, sprintId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [spEdits, setSpEdits] = useState({}); // issueKey -> input string
  const [drafts, setDrafts] = useState({}); // parentKey -> draft[]

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const params = new URLSearchParams({ team: teamKey || 'iota' });
      if (sprintId) params.set('sprintId', sprintId);
      const res = await fetch(`/api/grooming/sprint?${params}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
      setSpEdits({});
      setDrafts({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [teamKey, sprintId]);

  useEffect(() => {
    load();
  }, [load]);

  const trackers = data?.trackers || [];
  const types = data?.subtaskTypes || [];

  const originalSp = useMemo(() => {
    const map = {};
    for (const t of trackers) {
      map[t.key] = t.storyPoints;
      for (const s of t.subtasks) map[s.key] = s.storyPoints;
    }
    return map;
  }, [trackers]);

  const pending = useMemo(() => {
    const spUpdates = [];
    for (const [key, raw] of Object.entries(spEdits)) {
      const sp = parseSp(raw);
      if (sp !== null && sp !== (originalSp[key] ?? null)) {
        spUpdates.push({ issueKey: key, storyPoints: sp });
      }
    }
    const creates = [];
    for (const [parentKey, list] of Object.entries(drafts)) {
      for (const d of list) {
        if (!d.summary.trim()) continue;
        const typeMeta = types.find((t) => t.id === d.issueTypeId);
        const missing = (typeMeta?.requiredExtras || []).some((f) => !d.extraFields[f.key]);
        creates.push({
          parentKey,
          issueTypeId: d.issueTypeId,
          summary: d.summary,
          storyPoints: d.storyPoints,
          componentIds: d.componentIds,
          extraFields: d.extraFields,
          _missingRequired: missing
        });
      }
    }
    return { spUpdates, creates };
  }, [spEdits, drafts, originalSp, types]);

  const blocked = pending.creates.filter((c) => c._missingRequired).length;
  const pendingCount = pending.spUpdates.length + pending.creates.length;

  const apply = async () => {
    if (!pendingCount || blocked) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/grooming/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spUpdates: pending.spUpdates,
          creates: pending.creates.map(({ _missingRequired, ...c }) => c)
        })
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

  const addDraft = (tracker) => {
    const first = types[0];
    if (!first) return;
    // Team convention: subtasks carry the "Common" component.
    const common = data.components.find((c) => c.name === 'Common');
    setOpen((prev) => new Set(prev).add(tracker.key));
    setDrafts((prev) => ({
      ...prev,
      [tracker.key]: [
        ...(prev[tracker.key] || []),
        {
          issueTypeId: first.id,
          summary: `${first.name}: ${tracker.key} - ${tracker.summary}`,
          storyPoints: '',
          componentIds: common ? [common.id] : tracker.components.map((c) => c.id),
          extraFields: {}
        }
      ]
    }));
  };

  const updateDraft = (parentKey, idx, patch) =>
    setDrafts((prev) => ({
      ...prev,
      [parentKey]: prev[parentKey].map((d, i) => {
        if (i !== idx) return d;
        const next = { ...d, ...patch };
        // Changing the type refreshes the default summary prefix.
        if (patch.issueTypeId && patch.issueTypeId !== d.issueTypeId) {
          const t = types.find((x) => x.id === patch.issueTypeId);
          const oldT = types.find((x) => x.id === d.issueTypeId);
          if (t && oldT && d.summary.startsWith(`${oldT.name}:`)) {
            next.summary = d.summary.replace(`${oldT.name}:`, `${t.name}:`);
          }
        }
        return next;
      })
    }));

  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  if (loading) return <div className="loading">Loading sprint trackers…</div>;
  if (error && !data) return <div className="error-banner">Failed to load: {error}</div>;
  if (!data) return null;

  return (
    <>
      <section className="epic-toolbar">
        <div>
          <h1 className="epic-release-title">Grooming</h1>
          <div className="dev-meta">
            {trackers.length} tracker{trackers.length !== 1 ? 's' : ''} in this sprint · edit SP
            inline or add subtasks, then apply
          </div>
        </div>
        <div className="grooming-actions">
          <button type="button" className="btn" onClick={load} disabled={applying}>
            Reload
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={apply}
            disabled={applying || !pendingCount || blocked > 0}
            title={
              blocked
                ? `${blocked} new subtask(s) missing required fields`
                : 'Applies SP updates and creates new subtasks in Jira'
            }
          >
            {applying ? 'Applying…' : `Apply to Jira (${pendingCount})`}
          </button>
        </div>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {blocked > 0 && (
        <div className="error-banner">
          {blocked} new subtask{blocked !== 1 ? 's are' : ' is'} missing required fields (marked
          inputs) — fill them to enable Apply.
        </div>
      )}
      {results && (
        <div className="grooming-summary">
          {results.createResults.length > 0 &&
            `Created ${results.createResults.filter((r) => r.success).length}/${results.createResults.length} subtasks`}
          {results.createResults.length > 0 && results.spResults.length > 0 && ' · '}
          {results.spResults.length > 0 &&
            `updated SP on ${results.spResults.filter((r) => r.success).length}/${results.spResults.length} trackers`}
          {' · '}
          <button type="button" className="link-btn" onClick={load}>
            reload
          </button>
          {results.createResults
            .filter((r) => !r.success)
            .map((r) => (
              <div key={r.parentKey + r.typeName} className="err-text">
                {r.parentKey} {r.typeName}: {r.error}
              </div>
            ))}
          {results.spResults
            .filter((r) => !r.success)
            .map((r) => (
              <div key={r.issueKey} className="err-text">
                {r.issueKey}: {r.error}
              </div>
            ))}
        </div>
      )}

      <section className="dev-list">
        {trackers.map((t) => {
          const isOpen = open.has(t.key);
          return (
            <div key={t.key} className={`dev-card${isOpen ? ' open' : ''}`}>
              <div
                className="grooming-head clickable"
                onClick={() => toggle(t.key)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && toggle(t.key)}
              >
                <span className={`chevron-btn${isOpen ? ' up' : ''}`}>▾</span>
                <div className="task-key mono">
                  <a
                    href={`${data.jiraBaseUrl}/browse/${t.key}`}
                    target="_blank"
                    rel="noreferrer"
                    className="issue-link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.key}
                  </a>
                </div>
                <div className="grooming-title">
                  <div className="dev-name">{t.summary}</div>
                  <div className="dev-meta">
                    <span className="tracker-type">{t.type}</span>
                    <span className={`pill ${t.statusCategory}`}>{t.status}</span>
                    {t.assignee && ` ${t.assignee}`}
                    {` · ${t.subtasks.length} subtask${t.subtasks.length !== 1 ? 's' : ''}`}
                  </div>
                </div>
                <SpInput
                  original={t.storyPoints}
                  value={spEdits[t.key]}
                  onChange={(v) => setSpEdits((p) => ({ ...p, [t.key]: v }))}
                />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    addDraft(t);
                  }}
                >
                  + Subtask
                </button>
              </div>

              {isOpen && (
                <div className="grooming-rows">
                  {t.subtasks.map((s) => (
                    <div key={s.key} className="grooming-row">
                      <span className="task-key mono">
                        <a
                          href={`${data.jiraBaseUrl}/browse/${s.key}`}
                          target="_blank"
                          rel="noreferrer"
                          className="issue-link"
                        >
                          {s.key}
                        </a>
                      </span>
                      <span className="grooming-sub-summary">
                        <span className="tracker-type">{s.type}</span>
                        {s.summary}
                      </span>
                      <span className={`pill ${s.statusCategory}`}>{s.status}</span>
                      <SpInput
                        original={s.storyPoints}
                        value={spEdits[s.key]}
                        onChange={(v) => setSpEdits((p) => ({ ...p, [s.key]: v }))}
                      />
                    </div>
                  ))}
                  {!t.subtasks.length && !(drafts[t.key] || []).length && (
                    <div className="epic-empty">No subtasks yet — add one above.</div>
                  )}
                  {(drafts[t.key] || []).map((d, idx) => (
                    <NewSubtaskRow
                      key={idx}
                      draft={d}
                      types={types}
                      components={data.components}
                      onChange={(patch) => updateDraft(t.key, idx, patch)}
                      onRemove={() =>
                        setDrafts((prev) => ({
                          ...prev,
                          [t.key]: prev[t.key].filter((_, i) => i !== idx)
                        }))
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!trackers.length && <div className="loading">No trackers in this sprint for this team.</div>}
      </section>
    </>
  );
}
