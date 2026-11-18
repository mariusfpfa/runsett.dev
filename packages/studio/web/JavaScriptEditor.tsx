import { useLayoutEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

export function JavaScriptEditor({ source, edit }: { source: string; edit(source: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef({ source, edit });
  useLayoutEffect(() => {
    current.current = { source, edit };
  }, [source, edit]);
  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      doc: current.current.source,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'JavaScript source', spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            if (text !== current.current.source) current.current.edit(text);
          }
        }),
      ],
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && source !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
    }
  }, [source]);
  return <div className="js-source" ref={host} />;
}
