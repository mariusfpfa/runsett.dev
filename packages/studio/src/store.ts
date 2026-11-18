import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '@runsett/contracts';
import {
  assertTestInput,
  RequestError,
  greeting,
  uuid,
  validateDocument,
  validateForRun,
  type RunInput,
  type SavedWorkflow,
  type WorkflowDocument,
} from './model.js';

type DocumentRow = { id: string; revision: number; updated_at: string; body: string };
type Submission = {
  id: string;
  workflowId: string;
  revision: number;
  deploymentId: string;
  input: RunInput;
  usesTestInput?: true;
};
function unpack(row: DocumentRow): SavedWorkflow {
  return { id: row.id, revision: row.revision, updatedAt: row.updated_at, document: JSON.parse(row.body) };
}
export class StudioStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS submissions (request_id TEXT PRIMARY KEY, body TEXT NOT NULL);',
    );
  }
  seed() {
    if (!this.db.prepare('SELECT 1 FROM workflows LIMIT 1').get()) this.create(greeting());
  }
  list(): SavedWorkflow[] {
    const rows = this.db
      .prepare('SELECT * FROM workflows ORDER BY updated_at DESC, id')
      .all() as DocumentRow[];
    return rows.map(unpack);
  }
  get(id: string): SavedWorkflow {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as DocumentRow | undefined;
    if (!row) throw new RequestError('Workflow not found.', 404);
    return unpack(row);
  }
  create(value: unknown): SavedWorkflow {
    const document = validateDocument(value);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO workflows VALUES (?, 1, ?, ?)')
      .run(id, new Date().toISOString(), JSON.stringify(document));
    return this.get(id);
  }
  save(id: string, revision: number, value: WorkflowDocument): SavedWorkflow {
    const document = validateDocument(value);
    const update = this.db.prepare(
      'UPDATE workflows SET revision = revision + 1, updated_at = ?, body = ? WHERE id = ? AND revision = ?',
    );
    if (update.run(new Date().toISOString(), JSON.stringify(document), id, revision).changes !== 1) {
      throw new RequestError('This workflow changed in another tab. Reload to edit the latest version.', 409);
    }
    return this.get(id);
  }
  prepareRun(
    id: string,
    revision: number,
    requestId: string,
    deploymentId: string,
    testInput?: JsonValue,
  ): Submission {
    if (!uuid(requestId) || !Number.isSafeInteger(revision)) throw new RequestError('Invalid run request.');
    if (testInput !== undefined) assertTestInput(testInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT body FROM submissions WHERE request_id = ?').get(requestId);
      let submission: Submission;
      if (row) {
        submission = JSON.parse(String(row.body));
        if (submission.workflowId !== id || submission.revision !== revision)
          throw new RequestError('This run already belongs to a different revision.', 409);
        if (
          Boolean(submission.usesTestInput) !== (testInput !== undefined) ||
          (testInput !== undefined &&
            !isDeepStrictEqual(submission.input.value, JSON.parse(JSON.stringify(testInput))))
        )
          throw new RequestError('This run request already has a different input.', 409);
      } else {
        const workflow = this.get(id);
        if (workflow.revision !== revision)
          throw new RequestError('Save your latest changes before running this workflow.', 409);
        const value = validateForRun(workflow.document, testInput);
        const input = { name: workflow.document.name, revision, value, steps: workflow.document.steps };
        submission = {
          id: 'studio-' + id + '-' + requestId,
          workflowId: id,
          revision,
          deploymentId,
          input,
          ...(testInput !== undefined ? { usesTestInput: true } : {}),
        };
        this.db.prepare('INSERT INTO submissions VALUES (?, ?)').run(requestId, JSON.stringify(submission));
      }
      this.db.exec('COMMIT');
      return submission;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getSubmission(runId: string): Submission | undefined {
    const row = this.db.prepare('SELECT body FROM submissions WHERE request_id = ?').get(runId.slice(-36));
    if (!row) return;
    const submission: Submission = JSON.parse(String(row.body));
    return submission.id === runId ? submission : undefined;
  }
  close() {
    this.db.close();
  }
}
