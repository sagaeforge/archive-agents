import type { AnyExtension } from '@tiptap/core';
/** Offline Tiptap 3.32.0 adapters ported from the s7 spike. `doc: true` adds the quoted claim block and the block-move keys of a document. */
export function tiptapExtensions(options?: { doc?: boolean }): AnyExtension[];
