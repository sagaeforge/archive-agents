import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TextSelection } from 'prosemirror-state';
import './style.css';

// Shared application and measurement surface, identical for both candidates.
export function mount(name, createEditor) {
  function App() {
    const host = useRef(null);
    const [source, setSource] = useState('');
    useEffect(() => {
      let adapter;
      const events = [];
      const commands = [];
      const capture = (event) => {
        const record = {
          type: event.type, data: event.data ?? null, key: event.key ?? null,
          keyCode: event.keyCode ?? null, isComposing: event.isComposing ?? null,
          inputType: event.inputType ?? null, trusted: event.isTrusted,
          viewComposing: adapter?.view.composing ?? null,
        };
        events.push(record);
        if (event.type !== 'keydown' || event.key !== 'Enter') return;
        // This is application behavior, not an editor-provided slash/submit menu.
        const composing = event.isComposing || event.keyCode === 229 || adapter?.view.composing;
        record.commandSuppressedByComposition = Boolean(composing);
        if (composing) return;
        const { $from } = adapter.view.state.selection;
        const prefix = $from.parent.textBetween(0, $from.parentOffset);
        if (event.ctrlKey || event.metaKey || prefix.startsWith('/')) {
          commands.push({ command: event.ctrlKey || event.metaKey ? 'submit' : 'slash', ...record });
          event.preventDefault();
          event.stopPropagation();
        }
      };
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
        host.current.addEventListener(type, capture, true);
      }
      window.spike = {
        name,
        async reset(markdown) {
          await adapter?.destroy();
          host.current.replaceChildren();
          adapter = await createEditor(host.current, markdown);
          events.length = 0;
          commands.length = 0;
          return this.snapshot();
        },
        select(blockIndex, offset) {
          const blocks = this.snapshot().blocks;
          const block = blocks[blockIndex];
          if (!block) throw new Error(`Missing block ${blockIndex}`);
          const pos = block.position + 1 + offset;
          const view = adapter.view;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
          view.focus();
          return this.snapshot();
        },
        snapshot() {
          const view = adapter.view;
          const { doc, selection } = view.state;
          const blocks = [];
          doc.descendants((node, position) => {
            if (node.isTextblock) blocks.push({ type: node.type.name, position, text: node.textContent });
          });
          const dom = window.getSelection();
          return {
            text: doc.textBetween(0, doc.content.size, '\n', node => node.attrs.value ?? ''),
            markdown: adapter.serialize(), json: doc.toJSON(), blocks,
            caret: {
              from: selection.from, to: selection.to, parentOffset: selection.$from.parentOffset,
              parentType: selection.$from.parent.type.name,
              blockIndex: blocks.findIndex(b => b.position + 1 === selection.$from.start()),
              domAnchorOffset: dom?.anchorOffset ?? null, domAnchorText: dom?.anchorNode?.textContent ?? null,
            },
            composing: view.composing, events: events.slice(), commands: commands.slice(),
            html: view.dom.innerHTML,
          };
        },
      };
      window.spike.reset('한글 편집기 스파이크').then(() => { window.spike.ready = true; })
        .catch(error => { window.spike.error = String(error.stack); console.error(error); });
    }, []);
    return <main>
      <h1>{name} · Markdown 편집기</h1>
      <p>CommonMark, GFM 표·작업 목록, 실행 취소. / 입력 후 Enter: 명령, Ctrl+Enter: 저장.</p>
      <button onClick={() => setSource(window.spike.snapshot().markdown)}>Markdown 보기</button>
      <div ref={host} className="editor" />
      <pre aria-label="Markdown 원문">{source}</pre>
    </main>;
  }
  createRoot(document.getElementById('root')).render(<App />);
}
