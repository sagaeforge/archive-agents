// Writes fixtures/today.json and fixtures/large.json from the generator. Layout is not stored: the server computes it.
import { writeFileSync } from 'node:fs';
import { large, today } from '../dev/fixtures/gen.ts';

const here = new URL('../fixtures/', import.meta.url);
writeFileSync(new URL('today.json', here), JSON.stringify(today(), null, 1) + '\n');
writeFileSync(new URL('large.json', here), JSON.stringify(large(), null, 1) + '\n');
console.log('today', today().nodes.length, 'large', large().nodes.length);
