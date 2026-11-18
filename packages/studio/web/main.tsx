import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { JsonValue } from '@runsett/contracts';
import {
  ArrowUpRight,
  Blocks,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  FolderOpen,
  GitBranch,
  History,
  Layers2,
  LayoutGrid,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  Radio,
  SquareDashedMousePointer,
  Workflow,
  X,
} from 'lucide-react';
import {
  kindSettings,
  maxSteps,
  validateForRun,
  type SavedWorkflow,
  type StepKind,
  type WorkflowDocument,
} from '../src/model.js';
import { Canvas } from './Canvas.js';
import { Inspector } from './Inspector.js';
import { StepTestDialog } from './StepTestDialog.js';
import { NewWorkflow, StepLibrary } from './Dialogs.js';
import { ResultDialog, RunHistory } from './Runs.js';
import { IconButton } from './ui.js';
import { api, message, useWorkspace } from './workspace.js';
import './studio.css';

function App() {
  const ws = useWorkspace();
  const doc = ws.session?.draft,
    saved = ws.session?.saved;
  const [page, setPage] = useState<'editor' | 'history'>('editor');
  const [tab, setTab] = useState<'canvas' | 'runs'>('canvas');
  const [selection, setSelection] = useState('trigger');
  const [panel, setPanel] = useState(() => window.innerWidth > 940);
  const [sidebar, setSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [insertion, setInsertion] = useState<number | null>(null);
  const [testId, setTestId] = useState('');
  const testStep = doc?.steps.find((step) => step.id === testId);
  const [renaming, setRenaming] = useState(false);
  const [runId, setRunId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const lastRequest = useRef({ key: '', requestId: '' });
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<{ id: string; after: WorkflowDocument; before: WorkflowDocument } | null>(
    null,
  );
  const renameCancelled = useRef(false);
  useEffect(() => {
    setSelection(saved?.document.steps[0]?.id ?? 'trigger');
    setTestId('');
    setRenaming(false);
    setPanel(window.innerWidth > 940);
    setUndo(null);
    setNotice('');
    // An autosave updates the revision of the same open document.
  }, [saved?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice('');
      setUndo(null);
    }, 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  function editor() {
    setPage('editor');
    setTab('canvas');
    setSidebar(false);
  }
  async function openWorkflow(record: SavedWorkflow) {
    try {
      await ws.open(record);
      editor();
    } catch (e) {
      ws.setError(message(e));
    }
  }
  function select(id: string) {
    setSelection(id);
    setPanel(true);
  }
  function insert(kind: StepKind) {
    if (!doc || insertion === null || doc.steps.length >= maxSteps) return;
    const step = {
      id: 's-' + crypto.randomUUID(),
      kind,
      name: kindSettings[kind].name,
      setting: kindSettings[kind].initial,
    };
    const steps = [...doc.steps];
    steps.splice(insertion, 0, step);
    ws.edit({ ...doc, steps });
    setInsertion(null);
    editor();
    select(step.id);
    if (kind === 'javascript') setTestId(step.id);
  }
  function move(id: string, destination: number) {
    if (!doc) return;
    const from = doc.steps.findIndex((s) => s.id === id);
    if (from < 0 || from === destination || destination < 0 || destination >= doc.steps.length) return;
    const steps = [...doc.steps];
    const item = steps.splice(from, 1)[0]!;
    steps.splice(destination, 0, item);
    ws.edit({ ...doc, steps });
  }
  function remove(id: string) {
    if (!doc || !saved) return;
    const index = doc.steps.findIndex((s) => s.id === id);
    if (index < 0) return;
    const after = { ...doc, steps: doc.steps.filter((s) => s.id !== id) };
    setUndo({ id: saved.id, before: doc, after });
    setNotice('Step removed.');
    ws.edit(after);
    setSelection(after.steps[Math.min(index, after.steps.length - 1)]?.id ?? 'trigger');
  }
  const run = useCallback(
    async (testInput?: JsonValue) => {
      if (inFlight.current || ws.engine.status !== 'online') {
        if (testInput !== undefined)
          throw new Error(inFlight.current ? 'A workflow run is already starting.' : ws.engine.message);
        return;
      }
      inFlight.current = true;
      setSubmitting(true);
      ws.setError('');
      try {
        const record = await ws.flush();
        validateForRun(record.document, testInput);
        const key = JSON.stringify([
          record.id,
          record.revision,
          ...(testInput === undefined ? [] : [testInput]),
        ]);
        if (lastRequest.current.key !== key) lastRequest.current = { key, requestId: crypto.randomUUID() };
        const result = await api<{ workflowId: string }>('workflows/' + record.id + '/runs', 'POST', {
          revision: record.revision,
          requestId: lastRequest.current.requestId,
          ...(testInput === undefined ? {} : { testInput }),
        });
        lastRequest.current = { key: '', requestId: '' };
        if (testInput !== undefined) setTestId('');
        setRunId(result.workflowId);
      } catch (e) {
        if (testInput !== undefined) throw e;
        ws.setError(message(e));
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [ws],
  );
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === 'Enter' &&
        page === 'editor' &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault();
        void run();
      }
      if (e.key === 'Escape') setSidebar(false);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [page, run]);
  const engineText =
    ws.engine.status === 'online'
      ? 'Engine online'
      : ws.engine.status === 'starting'
        ? 'Starting engine'
        : 'Engine offline';
  const library = () => {
    if (doc) {
      setSidebar(false);
      setInsertion(doc.steps.length);
    }
  };
  function finishRename(name: string) {
    if (doc && !renameCancelled.current && name.trim() && name.trim() !== doc.name)
      ws.edit({ ...doc, name: name.trim() });
    setRenaming(false);
  }
  return (
    <div className={'studio-shell' + (sidebar ? ' nav-open' : '') + (collapsed ? ' nav-small' : '')}>
      {sidebar && (
        <button className="nav-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)} />
      )}
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="brand-row">
          <button className="brand" title="Runsett Studio" onClick={editor}>
            <img src="/assets/mark.svg" alt="" />
            <span>
              Runsett<span className="brand-dot">.</span>
            </span>
          </button>
          <IconButton
            label="Collapse navigation"
            className="collapse"
            onClick={() => {
              setCollapsed(true);
              setSidebar(false);
            }}
          >
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
        <div className="side-body">
          <div className="nav-group-label">Workspace</div>
          <nav>
            <button
              title="Workflow builder"
              className={'nav-item' + (page === 'editor' ? ' current' : '')}
              onClick={editor}
            >
              <Workflow size={18} />
              <span>Workflow builder</span>
            </button>
            <button
              title="Run history"
              className={'nav-item' + (page === 'history' ? ' current' : '')}
              onClick={() => {
                setPage('history');
                setSidebar(false);
              }}
            >
              <History size={18} />
              <span>Run history</span>
            </button>
            <button
              title="Step library"
              className="nav-item"
              disabled={!doc || doc.steps.length >= maxSteps}
              onClick={library}
            >
              <Blocks size={18} />
              <span>Step library</span>
            </button>
          </nav>
          <div className="sidebar-rule" />
          <div className="side-list-title">
            <div className="nav-group-label">My workflows</div>
            <button
              aria-label="Create new workflow"
              title="Create new workflow"
              onClick={() => setCreating(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="saved-list">
            {ws.records.map((record) => (
              <button
                key={record.id}
                title={record.document.name}
                className={record.id === saved?.id && page === 'editor' ? 'active' : ''}
                onClick={() => void openWorkflow(record)}
              >
                <GitBranch size={14} />
                <span>
                  {record.id === saved?.id
                    ? doc?.name || 'Untitled workflow'
                    : record.document.name || 'Untitled workflow'}
                </span>
              </button>
            ))}
          </div>
          <button
            className="new-workflow"
            title="New workflow"
            onClick={() => {
              setCreating(true);
              setSidebar(false);
            }}
          >
            <Plus size={15} />
            <span>New workflow</span>
          </button>
        </div>
        <footer className="side-footer">
          <a
            href={'http://localhost:8080/namespaces/' + encodeURIComponent(ws.namespace) + '/workflows'}
            target="_blank"
            rel="noreferrer"
            title="Open Temporal UI"
          >
            <SquareDashedMousePointer size={15} />
            <span>Temporal UI</span>
            <ArrowUpRight size={13} />
          </a>
          <div className="workspace-id">
            <div className="workspace-avatar">
              <Layers2 size={20} />
            </div>
            <div>
              <strong>Local workspace</strong>
              <small className={'engine-' + ws.engine.status}>
                <i />
                {engineText}
              </small>
            </div>
          </div>
        </footer>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <IconButton
              label="Open navigation"
              className="open-nav"
              onClick={() => {
                setCollapsed(false);
                setSidebar(window.innerWidth <= 760);
              }}
            >
              <Menu size={19} />
            </IconButton>
            <span className="desktop-crumb">
              <LayoutGrid size={15} />
              Workspace
            </span>
            <span className="compact-brand">
              <img src="/assets/mark.svg" alt="" />
              Runsett
            </span>
            <ChevronRight className="crumb-divider" size={13} />
            <strong>{page === 'history' ? 'Run history' : 'Workflow builder'}</strong>
          </div>
          <div className="top-actions">
            {page === 'editor' && (
              <span
                className={'save-indicator' + (ws.saveState === 'Saved' ? '' : ' pending-save')}
                title={ws.saveState === 'Saved' ? 'All changes saved' : ws.saveState}
              >
                {ws.saveState === 'Saved' ? <CircleCheck size={15} /> : <Clock3 size={15} />}
                <span>{ws.saveState === 'Saved' ? 'All changes saved' : ws.saveState}</span>
              </span>
            )}
            <button className="btn btn-light compact-new" onClick={() => setCreating(true)}>
              <Plus size={14} />
              New workflow
            </button>
          </div>
        </header>
        {ws.error && (
          <div className="banner error-banner" role="alert">
            <CircleAlert size={16} />
            <span>{ws.error}</span>
            <IconButton label="Dismiss error" onClick={() => ws.setError('')}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {ws.engine.status === 'offline' && (
          <div className="banner engine-banner">
            <Radio size={16} />
            <span>{ws.engine.message}</span>
            <button onClick={() => void ws.retry().catch((e) => ws.setError(message(e)))}>
              Retry engine
            </button>
          </div>
        )}
        {doc && saved ? (
          <>
            <div className="page-heading">
              <div className={'heading-tile' + (page === 'history' ? ' history-tile' : '')}>
                {page === 'history' ? <History size={23} /> : <Workflow size={24} />}
              </div>
              <div className="heading-text">
                {renaming && page === 'editor' ? (
                  <input
                    className="title-input"
                    aria-label="Workflow name"
                    autoFocus
                    maxLength={100}
                    defaultValue={doc.name}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => finishRename(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        renameCancelled.current = true;
                        setRenaming(false);
                      }
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                ) : (
                  <div className="title-line">
                    <h1>{page === 'history' ? 'Run history' : doc.name || 'Untitled workflow'}</h1>
                    {page === 'editor' && (
                      <IconButton
                        label="Rename workflow"
                        onClick={() => {
                          renameCancelled.current = false;
                          setRenaming(true);
                        }}
                      >
                        <Pencil size={14} />
                      </IconButton>
                    )}
                  </div>
                )}
                <p>
                  {page === 'history' ? (
                    <>
                      <History size={13} />
                      Workspace executions
                    </>
                  ) : (
                    <>
                      <span className="heading-meta">
                        <Radio size={13} /> Manual trigger
                      </span>
                      <b>·</b>
                      <span>
                        {doc.steps.length} {doc.steps.length === 1 ? 'step' : 'steps'}
                      </span>
                    </>
                  )}
                </p>
              </div>
              {page === 'editor' && (
                <div className="workflow-run-actions">
                  <button
                    className="btn btn-light"
                    onClick={() => setTestId('trigger')}
                    disabled={submitting}
                  >
                    Test with input…
                  </button>
                  <button
                    className="btn btn-primary run-button"
                    disabled={submitting || ws.engine.status !== 'online'}
                    onClick={() => void run()}
                    title="Run workflow (Ctrl or ⌘ Enter)"
                  >
                    {submitting || ws.engine.status === 'starting' ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Play size={15} fill="currentColor" />
                    )}
                    {submitting ? 'Starting…' : 'Run workflow'}
                  </button>
                </div>
              )}
            </div>
            {page === 'history' ? (
              <RunHistory open={setRunId} />
            ) : (
              <>
                <div className="editor-tabs" aria-label="Workflow views">
                  <button className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>
                    <GitBranch size={15} />
                    Editor
                  </button>
                  <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
                    <History size={15} />
                    Runs
                  </button>
                  {tab === 'canvas' && !panel && (
                    <button className="show-inspector" onClick={() => setPanel(true)}>
                      <PanelRightOpen size={15} />
                      Inspector
                    </button>
                  )}
                </div>
                {tab === 'runs' ? (
                  <RunHistory workflow={saved.id} open={setRunId} />
                ) : (
                  <div className={'editor-body' + (panel ? ' panel-open' : '')}>
                    <Canvas
                      key={saved.id}
                      doc={doc}
                      selection={selection}
                      onSelect={select}
                      onMove={move}
                      onInsert={setInsertion}
                    />
                    {panel && (
                      <>
                        <button
                          className="inspector-scrim"
                          aria-label="Dismiss step inspector"
                          onClick={() => setPanel(false)}
                        />
                        <Inspector
                          doc={doc}
                          selection={selection}
                          edit={ws.edit}
                          select={select}
                          move={move}
                          remove={remove}
                          test={setTestId}
                          close={() => setPanel(false)}
                        />
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <div className="history-empty">
            <FolderOpen />
            <strong>{ws.error ? 'Workspace unavailable' : 'Opening workspace…'}</strong>
            {ws.error && (
              <button className="btn btn-light" onClick={() => location.reload()}>
                Reload workspace
              </button>
            )}
          </div>
        )}
      </main>
      {creating && (
        <NewWorkflow
          close={() => setCreating(false)}
          create={async (document) => {
            await ws.create(document);
            editor();
          }}
        />
      )}
      {insertion !== null && <StepLibrary close={() => setInsertion(null)} insert={insert} />}
      {(testStep || testId === 'trigger') && doc && saved && (
        <StepTestDialog
          key={saved.id + '/' + testId}
          step={testStep ?? null}
          workflowId={saved.id}
          document={doc}
          engine={ws.engine}
          saveState={ws.saveState}
          saveError={ws.error}
          runWorkflow={run}
          edit={(source) =>
            testStep &&
            ws.edit({
              ...doc,
              steps: doc.steps.map((s) => (s.id === testStep.id ? { ...s, setting: source } : s)),
            })
          }
          close={() => setTestId('')}
        />
      )}
      {runId && <ResultDialog key={runId} id={runId} namespace={ws.namespace} close={() => setRunId('')} />}
      {notice && (
        <div className="toast" role="status">
          <CircleCheck size={16} />
          {notice}
          {undo && saved?.id === undo.id && JSON.stringify(doc) === JSON.stringify(undo.after) && (
            <button
              onClick={() => {
                ws.edit(undo.before);
                setUndo(null);
                setNotice('');
              }}
            >
              Undo
            </button>
          )}
          <IconButton label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
