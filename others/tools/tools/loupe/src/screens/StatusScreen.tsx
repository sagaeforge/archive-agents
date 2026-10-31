import { useSyncExternalStore } from 'react';
import { CONTRACT_STAMP } from '../client/stamp.ts';
import { compareSchemaVersion } from '../data/contractVersion.ts';
import { envelopeStore } from '../data/envelopeStore.ts';
import { KbProblem, KbUnavailable } from '../data/kbFetch.ts';
import { useMetaPoll } from '../data/hooks.ts';
import { useScreenTitle } from '../app/useScreenTitle.ts';
import { Button } from '@/components/ui/button';
import { Instant } from '../components/bits.tsx';

const Row = ({ k, v, id }: { k: string; v: string; id: string }) => (<><dt>{k}</dt><dd className="id break-all" data-testid={id}>{v}</dd></>);

// The path browser -> loupe serve -> socket -> KB, stated in numbers.
export function StatusScreen() {
  useScreenTitle('연결 상태');
  const q = useMetaPoll();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const meta = env.meta;
  const verdict = meta ? compareSchemaVersion(meta.schema_version, CONTRACT_STAMP.schemaVersion) : null;
  const err = q.error;
  const counts = q.data?.data.counts;
  return (
    <main className="page-narrow">
      <h1 className="page-title">연결 상태</h1>
      <p className="mt-1 text-sm text-soft">이 화면이 읽는 KB와, 이 빌드를 만든 계약이다.</p>
      <div className="mt-5 flex items-center gap-3">
        {q.isPending && !meta && <p className="text-sm" data-testid="kb-status">연결 중</p>}
        {err && <p role="alert" data-testid="kb-status" className="text-sm text-danger">{errorText(err)}</p>}
        {!err && meta && <p className="text-sm font-medium text-ok" data-testid="kb-status">연결됨</p>}
        <Button variant="outline" size="xs" onClick={() => void q.refetch()} disabled={q.isFetching}>다시 읽기</Button>
      </div>
      {meta && (
        <dl className="kv mt-4">
          <Row k="schema_version" v={meta.schema_version} id="kb-schema-version" />
          <Row k="계약 판정" v={verdict ?? '-'} id="kb-version-verdict" />
          <Row k="epoch" v={String(meta.epoch)} id="kb-epoch" />
          <Row k="applied_seq" v={String(meta.applied_seq)} id="kb-applied-seq" />
          <Row k="build_id" v={meta.build_id} id="kb-build-id" />
          <Row k="data_as_of" v={meta.data_as_of} id="kb-data-as-of" />
          <Row k="degraded" v={meta.degraded.join(', ') || '-'} id="kb-degraded" />
          {counts && <Row k="개수" v={`노드 ${counts.nodes ?? '-'}, 엣지 ${counts.edges ?? '-'}, 주장 ${counts.claims ?? '-'}`} id="kb-counts" />}
          <Row k="생성 입력" v={`${CONTRACT_STAMP.input} (${CONTRACT_STAMP.inputSha256.slice(0, 12)})`} id="contract-input" />
          {env.lastOkAt && <><dt>마지막 성공</dt><dd className="text-sm"><Instant iso={new Date(env.lastOkAt).toISOString()} seconds /></dd></>}
        </dl>
      )}
    </main>
  );
}

function errorText(err: Error) {
  if (err instanceof KbUnavailable) return `KB 사용 불가 (${err.reason}${err.code ? `, ${err.code}` : ''})`;
  if (err instanceof KbProblem) return `KB 오류 ${err.status} ${err.code ?? ''}`;
  return String(err);
}
