// Which window a database view is in. The document window provides its window id; the view keeps its filter and its save machines under it (store.ts).
import { createContext } from 'react';

export const DbScope = createContext<string>('');
