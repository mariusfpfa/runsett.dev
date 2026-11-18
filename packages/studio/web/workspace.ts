import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedWorkflow, WorkflowDocument } from '../src/model.js';

export async function api<T>(
  path: string,
  method = 'GET',
  payload?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/' + path, {
    method,
    ...(signal ? { signal } : {}),
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data as T;
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
export type Engine = { status: 'online' | 'offline' | 'starting'; message: string };
type Workspace = { workflows: SavedWorkflow[]; engine: Engine; namespace: string };
type Session = { saved: SavedWorkflow; draft: WorkflowDocument };

export function useWorkspace() {
  const [records, setRecords] = useState<SavedWorkflow[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [engine, setEngine] = useState<Engine>({ status: 'starting', message: 'Connecting…' });
  const [namespace, setNamespace] = useState('default');
  const [saveState, setSaveState] = useState('Saved');
  const [error, setError] = useState('');
  const current = useRef<Session | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const install = useCallback((next: Session) => {
    current.current = next;
    setSession(next);
  }, []);
  const select = useCallback(
    (saved: SavedWorkflow) => {
      install({ saved, draft: saved.document });
      localStorage.setItem('runsett.workflow', saved.id);
      setSaveState('Saved');
      setError('');
    },
    [install],
  );
  const remember = useCallback((saved: SavedWorkflow) => {
    setRecords((list) => [saved, ...list.filter((item) => item.id !== saved.id)]);
  }, []);
  useEffect(() => {
    let live = true;
    api<Workspace>('workspace')
      .then((data) => {
        if (!live) return;
        setRecords(data.workflows);
        setEngine(data.engine);
        setNamespace(data.namespace);
        const doc =
          data.workflows.find((item) => item.id === localStorage.getItem('runsett.workflow')) ??
          data.workflows[0];
        if (doc) select(doc);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [select]);
  useEffect(() => {
    let live = true;
    const timer = window.setInterval(
      () => {
        api<Engine>('engine')
          .then((result) => {
            if (live) setEngine(result);
          })
          .catch(() => {
            if (live)
              setEngine({ status: 'offline', message: 'Studio is disconnected. Check the local server.' });
          });
      },
      engine.status === 'starting' ? 1200 : 6000,
    );
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [engine.status]);
  const save = useCallback(() => {
    const task = async () => {
      while (current.current && current.current.draft !== current.current.saved.document) {
        const { saved, draft } = current.current;
        setSaveState('Saving…');
        const result = await api<SavedWorkflow>('workflows/' + saved.id, 'PUT', {
          revision: saved.revision,
          document: draft,
        });
        remember(result);
        if (current.current.saved.id !== saved.id) return;
        install({
          saved: result,
          draft: current.current.draft === draft ? result.document : current.current.draft,
        });
      }
      setSaveState('Saved');
    };
    const pending = queue.current.then(task);
    queue.current = pending.catch((e) => {
      setSaveState('Unsaved');
      setError(message(e));
    });
    return pending;
  }, [install, remember]);
  useEffect(() => {
    if (!session || session.saved.document === session.draft) return;
    const timer = window.setTimeout(() => {
      void save().catch(() => {});
    }, 600);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeunload', warn);
    };
  }, [session, save]);
  function edit(draft: WorkflowDocument) {
    if (!current.current) return;
    setSaveState('Unsaved');
    setError('');
    install({ saved: current.current.saved, draft });
  }
  async function open(saved: SavedWorkflow) {
    await save();
    if (current.current?.saved.id !== saved.id) select(saved);
  }
  async function create(document: WorkflowDocument) {
    await save();
    const result = await api<SavedWorkflow>('workflows', 'POST', document);
    remember(result);
    select(result);
  }
  async function flush(): Promise<SavedWorkflow> {
    await save();
    if (!current.current) throw new Error('Open a workflow first.');
    return current.current.saved;
  }
  const retry = async () => setEngine(await api<Engine>('engine/retry', 'POST', {}));
  return {
    records,
    session,
    engine,
    namespace,
    saveState,
    error,
    setError,
    edit,
    open,
    create,
    flush,
    retry,
  };
}
