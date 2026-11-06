// The task detail window lives in the window manager like a record, under an id no KB record can have (settings do the same, settings/id.ts).
import { parseKbId } from '../ids.ts';
export const TASK_WINDOW_PREFIX = 'loupe:task:';
export const taskWindowId = (spec: string) => `${TASK_WINDOW_PREFIX}${spec}`;
export const isTaskWindow = (id: string) => id.startsWith(TASK_WINDOW_PREFIX) && parseKbId(id.slice(TASK_WINDOW_PREFIX.length)).ok;
export const taskSpecOf = (id: string) => id.slice(TASK_WINDOW_PREFIX.length);
