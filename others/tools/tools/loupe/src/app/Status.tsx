// Connection state in the header and the red band (design 7.3, 7.4).
import { useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Chip, Instant } from '../components/bits.tsx';
import { connection } from '../data/connection.ts';
import { compareSchemaVersion } from '../data/contractVersion.ts';
import { envelopeStore } from '../data/envelopeStore.ts';
import { useNewDataPending } from '../data/lifecycle.ts';
import { noticeStore, useNotices } from '../data/notices.ts';
import { CONTRACT_STAMP } from '../client/stamp.ts';
import { describeError } from '../lib/errors.ts';
import { KbUnavailable } from '../data/kbFetch.ts';

// Only the values the viewer can explain. Anything else is ignored, as C 2.1 asks.
const DEGRADED_LABEL: Record<string, string> = {
  lexical_only: '어휘 검색만', vector_offline: '벡터 색인 꺼짐', stale_build: '빌드 지연', boot_path_unverified: '기동 경로 미확인',
};
export const knownDegraded = (values: readonly string[]) => values.filter((v) => Object.hasOwn(DEGRADED_LABEL, v)).map((v) => ({ value: v, label: DEGRADED_LABEL[v]! }));

export function HeaderStatus() {
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const conn = useSyncExternalStore(connection.subscribe, connection.get);
  const newData = useNewDataPending();
  const meta = env.meta;
  const verdict = meta ? compareSchemaVersion(meta.schema_version, CONTRACT_STAMP.schemaVersion) : null;
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-xs text-faint">
      {newData && <Chip tone="info" data-testid="new-data">새 데이터 있음</Chip>}
      {verdict === 'minor-differs' && <Chip tone="warn" data-testid="minor-warning" title={`받은 값 ${meta?.schema_version}, 생성본 ${CONTRACT_STAMP.schemaVersion}`}>계약 판 다름</Chip>}
      {meta && knownDegraded(meta.degraded).map((d) => <Chip key={d.value} tone="quiet" data-testid="degraded">{d.label}</Chip>)}
      <Link to="/status" className="status-link" title="연결 상태" data-testid="header-status">
        <span className="dot" data-state={conn.down ? 'down' : meta ? 'ok' : 'wait'} aria-hidden />
        {meta ? <span className="hidden tabular-nums sm:inline" data-testid="data-as-of">자료 <Instant iso={meta.data_as_of} /></span> : <span>{conn.down ? '끊김' : '연결 중'}</span>}
      </Link>
    </div>
  );
}

export function OfflineBand() {
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  const conn = useSyncExternalStore(connection.subscribe, connection.get);
  if (!conn.down || !conn.last) return null;
  const { reason, status, code } = conn.last;
  const info = describeError(new KbUnavailable(reason, '', status, code));
  return (
    <div role="alert" data-testid="offline-band" data-code={code ?? undefined} className="offline-band">
      <strong className="font-semibold">KB에 닿지 않는다</strong>
      <span>{info.detail}</span>
      {env.lastOkAt && <span>마지막 성공 <Instant iso={new Date(env.lastOkAt).toISOString()} /></span>}
      {env.meta && <span>마지막 자료 <Instant iso={env.meta.data_as_of} /></span>}
      {info.retry && <span>30초마다 다시 시도한다</span>}
    </div>
  );
}

export function ContractBlock({ received }: { received: string }) {
  return (
    <main className="page-narrow" data-testid="contract-block" role="alert">
      <h1 className="page-title">계약이 맞지 않는다</h1>
      <p className="mt-2 text-soft">KB가 이 빌드가 아는 계약과 다른 판을 내고 있다. 다시 생성할 때까지 화면을 그리지 않는다.</p>
      <dl className="kv mt-4">
        <dt>받은 값</dt><dd className="id" data-testid="contract-received">{received}</dd>
        <dt>지원 값</dt><dd className="id" data-testid="contract-supported">{CONTRACT_STAMP.schemaVersion}</dd>
      </dl>
    </main>
  );
}

/** Short notices raised by the data layer, such as a list that restarted from page 1 (design 7.3). */
export function Notices() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col" data-testid="notices">
      {notices.map((n) => (
        <p key={n.id} role="status" className="notice notice-bar" data-testid="notice">
          <span>{n.text}</span>
          <button type="button" className="text-action ml-auto" onClick={() => noticeStore.dismiss(n.id)}>닫기</button>
        </p>
      ))}
    </div>
  );
}
