export function findLocalPaths(dir: string): { file: string; match: string }[];
export const GRAPH_VENDOR_BUDGET_GZ: number;
export function checkGraphBundle(dir: string): { ok: boolean; gzBytes: number; problems: string[] };
export function checkEditorBundle(dir: string): {
  ok: boolean; problems: string[]; firstScreen: { name: string; gzBytes: number }[]; editor: { name: string; gzBytes: number }[];
  firstScreenGzBytes: number; editorGzBytes: number;
};
