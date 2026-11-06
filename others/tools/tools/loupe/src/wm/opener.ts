// How a window that sits inside the window manager asks it for something (design v2 2.7 "링크가 창을 연다"): a document opens the target of a link in a
// window, closes itself after "보관", opens the settings. The shell sets these when it mounts; before that (and in a test of one window alone) they do nothing.
export const windows: { open: (id: string) => void; close: (id: string) => void } = { open: () => undefined, close: () => undefined };
