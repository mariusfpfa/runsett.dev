import { useState } from 'react';
import type { JsonValue } from '@runsett/contracts';
import { assertTestInput } from '../src/model.js';
import { useInvalidDraft, type MarkInvalid } from './ui.js';

function JsonField({
  label,
  value,
  update,
  markInvalid,
}: {
  label: string;
  value: JsonValue | undefined;
  update(value: JsonValue): void;
  markInvalid: MarkInvalid;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useInvalidDraft(invalid, markInvalid);
  return (
    <label className="field">
      <span className="field-title">
        {label}
        <small>JSON</small>
      </span>
      <textarea
        className="mono"
        rows={2}
        spellCheck={false}
        maxLength={16_384}
        aria-label={label + ' (JSON)'}
        aria-invalid={invalid}
        value={draft ?? JSON.stringify(value, null, 2) ?? ''}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          try {
            const next: unknown = JSON.parse(text);
            assertTestInput(next);
            update(next);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        onBlur={() => {
          if (!invalid) setDraft(null);
        }}
      />
      {invalid && (
        <small className="field-error" role="status">
          Enter valid JSON to save this value. Put text in double quotes.
        </small>
      )}
    </label>
  );
}

export function DataFields({
  kind,
  settings,
  change,
  markInvalid,
}: {
  kind: 'set-field' | 'filter-list' | 'choose';
  settings: Record<string, JsonValue>;
  change(setting: string): void;
  markInvalid: MarkInvalid;
}) {
  function patch(key: string, value: JsonValue) {
    change(JSON.stringify({ ...settings, [key]: value }));
  }
  const paths = {
    'set-field': 'Use a dotted path, such as contact.name.',
    'filter-list': 'Leave empty to compare each whole item, or enter a path such as contact.name.',
    choose: 'Leave empty to compare the whole input, or enter a path such as contact.name.',
  };
  return (
    <>
      <label className="field">
        {kind === 'filter-list' ? 'Item field path' : 'Field path'}
        <input
          className="mono"
          placeholder={kind === 'set-field' ? 'contact.name' : 'Optional'}
          value={typeof settings.path === 'string' ? settings.path : ''}
          onChange={(event) => patch('path', event.target.value)}
        />
        <small>{paths[kind]}</small>
      </label>
      {kind === 'set-field' ? (
        <JsonField
          label="New value"
          value={settings.value}
          update={(value) => patch('value', value)}
          markInvalid={markInvalid}
        />
      ) : (
        <JsonField
          label="Equals"
          value={settings.equals}
          update={(value) => patch('equals', value)}
          markInvalid={markInvalid}
        />
      )}
      {kind === 'choose' && (
        <div className="choice-values">
          <JsonField
            label="If matched, return"
            value={settings.then}
            update={(value) => patch('then', value)}
            markInvalid={markInvalid}
          />
          <JsonField
            label="Otherwise, return"
            value={settings.else}
            update={(value) => patch('else', value)}
            markInvalid={markInvalid}
          />
        </div>
      )}
    </>
  );
}
