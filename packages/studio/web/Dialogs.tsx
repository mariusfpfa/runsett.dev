import { useState } from 'react';
import { ArrowRight, Check, FileText, Search, SearchX, Workflow } from 'lucide-react';
import { greeting, type StepKind, type WorkflowDocument } from '../src/model.js';
import { isTriggerKind, kinds, libraryGroups, Modal, Tile, type TriggerKind } from './ui.js';
import { message } from './workspace.js';

export function StepLibrary({
  close,
  insert,
  configureTrigger,
  activeTriggers,
  stepsFull,
}: {
  close(): void;
  insert(kind: StepKind): void;
  configureTrigger(kind: TriggerKind): void;
  activeTriggers: TriggerKind[];
  stepsFull: boolean;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const term = search.trim().toLowerCase();
  const visible = libraryGroups
    .filter((group) => category === 'All' || category === group.name)
    .map((group) => ({
      name: group.name,
      entries: group.kinds.filter((kind) =>
        [kinds[kind].name, kinds[kind].hint, kinds[kind].label, group.name]
          .join(' ')
          .toLowerCase()
          .includes(term),
      ),
    }))
    .filter((group) => group.entries.length > 0);
  return (
    <Modal title="Step library" className="library-dialog" close={close}>
      <div className="library-tools">
        <label className="search-box">
          <Search size={17} />
          <input
            autoFocus
            aria-label="Search steps"
            placeholder="Search steps and triggers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="library-filters" role="group" aria-label="Library categories">
          {['All', ...libraryGroups.map((group) => group.name)].map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={category === name}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="library-results">
        {visible.map((group) => (
          <section className="library-group" key={group.name} aria-label={group.name}>
            <h3>{group.name}</h3>
            <div className="block-list">
              {group.entries.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={!isTriggerKind(kind) && stepsFull}
                  onClick={() => (isTriggerKind(kind) ? configureTrigger(kind) : insert(kind))}
                >
                  <Tile kind={kind} small />
                  <span>
                    <strong>{kinds[kind].name}</strong>
                    <small>{kinds[kind].hint}</small>
                  </span>
                  {isTriggerKind(kind) && activeTriggers.includes(kind) ? (
                    <Check size={14} aria-label="Active" />
                  ) : (
                    <ArrowRight size={14} />
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
        {stepsFull && <p className="body-note">This workflow has reached its step limit.</p>}
        {!visible.length && (
          <div className="library-empty">
            <SearchX size={22} />
            <p>
              No matches for “{search}” in {category === 'All' ? 'the library' : category}.
            </p>
            <button
              className="btn btn-light"
              onClick={() => {
                setSearch('');
                setCategory('All');
              }}
            >
              Show all steps
            </button>
          </div>
        )}
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
