// A memo window lives in the window manager like a record, under an id no KB record can have (ids of the KB never start with this prefix).
// Its draft is not a KB record until the first save, and a saved one is still opened by this id, so the address never names it.
export const MEMO_WINDOW_PREFIX = 'loupe:memo:';
export const memoWindowId = (uuid: string) => `${MEMO_WINDOW_PREFIX}${uuid}`;
export const isMemoWindow = (id: string) => /^loupe:memo:[0-9a-f-]{8,40}$/i.test(id);
