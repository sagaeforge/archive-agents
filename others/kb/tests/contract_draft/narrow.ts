// SearchHit을 kind로 좁히고 나머지가 never임을 컴파일로 확인한다.
import type { SearchHit } from './gen/model';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(_?: T) => undefined;

export function describeHit(hit: SearchHit): string {
  switch (hit.kind) {
    case 'claim': {
      const subject: string = hit.subject;
      return subject;
    }
    case 'record': {
      const author: string | null = hit.author;
      return author ?? '';
    }
    case 'entity': {
      return hit.id;
    }
    case 'passage': {
      const span: number = hit.end - hit.start;
      return `${hit.snapshot_id}:${span}`;
    }
    default: {
      const rest: never = hit;
      return rest;
    }
  }
}

// kind는 정확히 네 값이다.
type Kinds = SearchHit['kind'];
assertTrue<Equal<Kinds, 'claim' | 'record' | 'entity' | 'passage'>>();
