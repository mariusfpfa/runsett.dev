import { useState } from 'react';
import { ArrowRight, Check, FileText, Search, Workflow } from 'lucide-react';
import { greeting, type StepKind, type WorkflowDocument } from '../src/model.js';
import { actionKinds, kinds, Modal, Tile } from './ui.js';
import { message } from './workspace.js';

export function StepLibrary({ close, insert }: { close(): void; insert(kind: StepKind): void }) {
  const [search, setSearch] = useState('');
  const visible = actionKinds.filter((kind) =>
    (kinds[kind].name + ' ' + kinds[kind].hint).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Modal title="Add a step" close={close}>
      <div className="dialog-body">
        <label className="search-box">
          <Search size={17} />
          <input
            autoFocus
            aria-label="Search steps"
            placeholder="Search steps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="block-list">
          {visible.map((kind) => (
            <button key={kind} onClick={() => insert(kind)}>
              <Tile kind={kind} />
              <span>
                <strong>{kinds[kind].name}</strong>
                <small>{kinds[kind].hint}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
          {!visible.length && <p className="empty-inline">No steps match “{search}”.</p>}
        </div>
      </div>
    </Modal>
  );
}
export function NewWorkflow({
  close,
  create,
}: {
  close(): void;
  create(doc: WorkflowDocument): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [starter, setStarter] = useState('blank');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = [
    {
      id: 'blank',
      title: 'Blank workflow',
      sub: 'Start with a manual trigger and an output.',
      icon: FileText,
    },
    { id: 'welcome', title: 'Welcome message', sub: 'Format a name and compose a greeting.', icon: Workflow },
  ];
  return (
    <Modal
      title="Create workflow"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          try {
            const doc =
              starter === 'blank'
                ? { name: '', inputMode: 'text' as const, steps: [], sampleInput: '' }
                : greeting();
            await create({ ...doc, name: name.trim() });
            close();
          } catch (err) {
            setError(message(err));
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <label className="field">
            Workflow name
            <input
              autoFocus
              required
              maxLength={100}
              placeholder="e.g. Format a new lead"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field">Starting point</div>
          <div className="template-list">
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-pressed={starter === choice.id}
                className={starter === choice.id ? 'chosen' : ''}
                onClick={() => setStarter(choice.id)}
              >
                <choice.icon size={21} />
                <span>
                  <strong>{choice.title}</strong>
                  <small>{choice.sub}</small>
                </span>
                <i>{starter === choice.id && <Check size={12} />}</i>
              </button>
            ))}
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-bottom">
          <button type="button" className="btn btn-light" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create workflow'}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
