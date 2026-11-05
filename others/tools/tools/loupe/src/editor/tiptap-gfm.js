// Offline feature adapters: the official Tiptap table extension is not installed. There is no image node: KB stores no attachments (design 4.4), so a
// Markdown image is kept as source text (sourceImage in tiptap-markdown.js) and never becomes an <img>.
// Reuse the installed MIT prosemirror-tables schema and editing plugin; do not
// emulate a complete @tiptap/extension-table package. Source: installed
// @tiptap/pm 3.32.0 tables / prosemirror-tables tableNodes(), 2026-11-04.
import { Node } from '@tiptap/core';
import { tableNodes, tableEditing } from '@tiptap/pm/tables';

const specs = tableNodes({ tableGroup: 'block', cellContent: 'block+' });
const table = Node.create({
  name: 'table', group: 'block', content: 'table_row+', isolating: true,
  tableRole: 'table',
  extendNodeSchema: extension => ({ tableRole: ({ table: 'table', table_row: 'row', table_cell: 'cell', table_header: 'header_cell' })[extension.name] }),
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: () => ['table', ['tbody', 0]],
  addProseMirrorPlugins: () => [tableEditing()],
  parseMarkdown: (token, h) => {
    const row = (cells, header) => h.createNode('table_row', {}, cells.map((cell, index) =>
      h.createNode(header ? 'table_header' : 'table_cell', { align: token.align?.[index] ?? null }, [
        h.createNode('paragraph', {}, h.parseInline(cell.tokens ?? [])),
      ])));
    return h.createNode('table', {}, [row(token.header, true), ...(token.rows ?? []).map(cells => row(cells, false))]);
  },
  renderMarkdown: (node, h) => {
    const rows = node.content ?? [];
    const renderRow = row => '| ' + row.content.map(cell =>
      h.renderChildren(cell.content).replace(/\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|')).join(' | ') + ' |';
    if (!rows.length) return '';
    const separator = '| ' + rows[0].content.map(cell => ({ left: ':---', right: '---:', center: ':---:' })[cell.attrs?.align] || '---').join(' | ') + ' |';
    return [renderRow(rows[0]), separator, ...rows.slice(1).map(renderRow)].join('\n');
  },
});
const row = Node.create({
  name: 'table_row', content: '(table_cell | table_header)+', tableRole: 'row',
  parseHTML: () => [{ tag: 'tr' }], renderHTML: () => ['tr', 0],
});
const cell = name => Node.create({
  name, content: specs[name].content, isolating: true, tableRole: specs[name].tableRole,
  addAttributes: () => ({
    colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null },
    align: { default: null, renderHTML: attrs => attrs.align ? { style: `text-align: ${attrs.align}` } : {} },
  }),
  parseHTML: () => [{ tag: name === 'table_header' ? 'th' : 'td' }],
  renderHTML: ({ HTMLAttributes }) => [name === 'table_header' ? 'th' : 'td', HTMLAttributes, 0],
});
export const offlineGfm = [table, row, cell('table_header'), cell('table_cell')];
