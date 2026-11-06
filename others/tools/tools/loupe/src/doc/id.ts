// The windows of M2 live in the window manager under ids no KB record can have (the memo window and the settings window do the same):
// a document that has not been opened from the KB, and the trash. A saved document is still opened by its window id, so the address never names it.
export const DOC_WINDOW_PREFIX = 'loupe:doc:';
export const docWindowId = (uuid: string) => `${DOC_WINDOW_PREFIX}${uuid}`;
export const isDocWindow = (id: string) => /^loupe:doc:[0-9a-f-]{8,40}$/i.test(id);
export const TRASH_ID = 'loupe:trash';
