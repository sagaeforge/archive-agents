// The settings window (design v2 2.8): nine cards in a grid, no list at the side. What touches security is shown, never changed:
// the allowed account, the break-glass path, the KB tokens, the trust of a device and the secret window's lock time belong to a
// terminal, so those cards carry text and the command, no control. What the web may change is the lock, the default visibility of
// new records and the appearance, all of it in this browser.
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Instant } from '../components/bits.tsx';
import { authStore } from '../auth/session.ts';
import { connection } from '../data/connection.ts';
import { appearance, readDefaults, useAppearance, writeDefaults, type Defaults, type GraphMode, type Motion, type TextSize, type Theme, type Visibility } from './appearance.ts';
import { lock } from './lock.ts';
import { idleText, maxText, useSettingsStatus, type SettingsStatus } from './statusApi.ts';

const POLL_MS = 30_000;
const DASH = '—';
const Card = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section className="settings-card" data-testid="settings-card" data-card={id} aria-labelledby={`settings-${id}`}>
    <h2 id={`settings-${id}`}>{title}</h2>
    {children}
  </section>
);
const Row = ({ k, v }: { k: string; v: ReactNode }) => <div className="contents" data-row={k}><dt>{k}</dt><dd>{v}</dd></div>;
const yes = (v: boolean, on: string, off: string) => (v ? on : off);
const Cmd = ({ children }: { children: string }) => <code>{children}</code>;

export default function SettingsWindow() {
  const result = useSettingsStatus(POLL_MS);
  const status = result?.ok ? result.status : null;
  const at = result?.ok ? result.at : 0;
  const failed = result !== null && !result.ok;
  const auth = useSyncExternalStore(authStore.subscribe, authStore.get);
  const conn = useSyncExternalStore(connection.subscribe, connection.get);
  const wait = (v: ReactNode) => (status ? v : failed ? '읽지 못했다' : '읽는 중');
  const left = (ms: number) => ms - (Date.now() - at);
  // The same word as the avatar's dot: the app's own count of failures (design 7.4), or the server saying it cannot reach the KB.
  const kbDown = conn.down || status?.kb.connected === false;
  return (
    <div className="settings-grid" data-testid="settings-grid">
      <Card id="account" title="계정과 세션">
        <dl>
          <Row k="허용 계정" v={wait(status ? `허용 계정 ${status.account.allowed}${status.account.via === 'breakglass' ? ' · 비상 경로로 들어옴' : ''}` : null)} />
          <Row k="세션" v={wait(status && `${idleText(left(status.session.idle_left_ms))} (한도 ${Math.round(status.session.idle_ms / 60_000)}분)`)} />
          <Row k="최대" v={wait(status && `${maxText(left(status.session.max_left_ms))} (한도 ${Math.round(status.session.max_ms / 3_600_000)}시간)`)} />
          <Row k="이 출처" v={location.origin} />
        </dl>
        <p>계정 바꾸기는 터미널에서 <Cmd>loupe google-enroll</Cmd></p>
      </Card>

      <Card id="lock" title="잠그기">
        <p>서버가 이 세션을 지운다. 열어 둔 창과 쓰던 글은 이 탭에 남고, 다시 로그인하면 이어진다. Google의 로그인은 그대로다.</p>
        <button type="button" className="settings-action" data-testid="settings-lock" disabled={auth.kind !== 'signed-in'} onClick={() => void lock()}>지금 잠그기 (Ctrl+Alt+L)</button>
      </Card>

      <Card id="devices" title="기기(패스키)">
        <dl>
          <Row k="인증기" v={wait(status?.kb.write ? (status.kb.write.hitl.available ? (status.kb.write.hitl.registered ? '신뢰됨' : '등록 대기') : `쓸 수 없음 (${status.kb.write.hitl.trust_store})`) : DASH)} />
        </dl>
        <button type="button" className="settings-action" data-testid="device-enroll" disabled title="쓰기 경로가 열리는 단계(M1)에서 연결한다">등록 시작</button>
        <p>신뢰와 폐기는 터미널에서 <Cmd>sudo kb reviewer enroll --request &lt;ID&gt;</Cmd>, <Cmd>sudo kb reviewer revoke</Cmd></p>
      </Card>

      <KbCard status={status} down={kbDown} wait={wait} />

      <DefaultsCard />

      <Card id="shortcuts" title="단축키">
        <table>
          <thead><tr><th scope="col">키</th><th scope="col">동작</th><th scope="col">일반 탭</th></tr></thead>
          <tbody>
            <tr><td><kbd>Ctrl+K</kbd></td><td>찾기</td><td>됨</td></tr>
            <tr><td><kbd>Ctrl+,</kbd></td><td>설정</td><td>됨</td></tr>
            <tr><td><kbd>Ctrl+Alt+L</kbd></td><td>잠그기</td><td>됨</td></tr>
            <tr><td><kbd>Alt+`</kbd></td><td>창 돌리기</td><td>됨</td></tr>
            <tr><td><kbd>Alt+M</kbd> · <kbd>Alt+0</kbd></td><td>창 내리기 · 모두</td><td>됨</td></tr>
            <tr><td><kbd>Alt+W</kbd></td><td>창 닫기</td><td>됨</td></tr>
            <tr><td><kbd>Alt+N</kbd></td><td>만들기</td><td>메모 단계(M1)에서 열린다</td></tr>
          </tbody>
        </table>
        <p>키를 바꾸는 일은 나중 단계다. 브라우저가 쥔 Ctrl+N, Ctrl+W, Ctrl+T는 쓰지 않는다.</p>
      </Card>

      <AppearanceCard />

      <Card id="secret" title="비밀 창">
        <dl>
          <Row k="주소" v={wait(status && `http://127.0.0.1:${status.secret_window.port}`)} />
          <Row k="소켓 fd" v={wait(status && yes(status.secret_window.socket_fd, '받음', '없음'))} />
          <Row k="잠금" v={wait(status && `유휴 ${Math.round(status.secret_window.lock_idle_ms / 60_000)}분`)} />
          <Row k="클립보드 비움" v={wait(status && `${Math.round(status.secret_window.clipboard_clear_ms / 1000)}초 뒤`)} />
        </dl>
        <p>비밀 창은 KMS를 붙이는 단계(M3)에서 열린다. 잠금 시간은 웹에서 바꾸지 않는다.</p>
      </Card>

      <Card id="breakglass" title="비상 경로">
        <dl>
          <Row k="상태" v={wait(status && yes(status.breakglass.open, '열림', '닫힘'))} />
          <Row k="마지막 연 시각" v={wait(status && (status.breakglass.last_opened ? <Instant iso={status.breakglass.last_opened} seconds /> : '기록 없음'))} />
          <Row k="마지막 쓴 시각" v={wait(status && (status.breakglass.last_used ? <Instant iso={status.breakglass.last_used} seconds /> : '기록 없음'))} />
        </dl>
        <p>열기는 터미널에서 <Cmd>loupe breakglass open</Cmd>. 1시간 뒤나 Google 로그인 한 번이면 닫힌다. 시각은 서버가 켜진 뒤의 것만 안다.</p>
      </Card>
    </div>
  );
}

function KbCard({ status, down, wait }: { status: SettingsStatus | null; down: boolean; wait: (v: ReactNode) => ReactNode }) {
  const kb = status?.kb;
  const w = !down ? kb?.write ?? null : null;
  const v = (f: (x: NonNullable<typeof w>) => ReactNode) => (w ? f(w) : DASH);
  return (
    <Card id="kb" title="KB 연결과 상태">
      <p><span data-testid="settings-kb-state" data-state={down ? 'down' : kb ? 'ok' : 'wait'}>{down ? '끊김' : kb ? '연결됨' : '연결 중'}</span></p>
      <dl>
        <Row k="data_as_of" v={wait(!down && kb?.data_as_of ? <Instant iso={kb.data_as_of} seconds /> : DASH)} />
        <Row k="fp_gate" v={wait(v((x) => yes(x.fp_gate, '켜짐', '꺼짐')))} />
        <Row k="editor_routes" v={wait(v((x) => `${x.editor_routes}개`))} />
        <Row k="private_open" v={wait(v((x) => yes(x.private_open, '열림', '닫힘')))} />
        <Row k="hitl.available" v={wait(v((x) => yes(x.hitl.available, '가능', '불가')))} />
        <Row k="trust_store" v={wait(v((x) => x.hitl.trust_store))} />
        <Row k="secret_rules" v={wait(v((x) => x.secret_rules.version ?? '없음'))} />
        <Row k="사전 검사" v="꺼짐 (이 빌드에 규칙이 없다)" />
        <Row k="editor 토큰" v={wait(status && (status.tokens.editor.days_left === null ? '설정 안 됨' : `${status.tokens.editor.days_left}일 남음`))} />
        <Row k="reviewer 토큰" v={wait(status && (status.tokens.reviewer.days_left === null ? '설정 안 됨' : `${status.tokens.reviewer.days_left}일 남음`))} />
      </dl>
    </Card>
  );
}

function DefaultsCard() {
  const [d, setD] = useState<Defaults>(readDefaults);
  const set = (patch: Partial<Defaults>) => { const next = { ...d, ...patch }; setD(next); writeDefaults(next); };
  const Select = ({ id, label, k }: { id: string; label: string; k: keyof Defaults }) => (
    <label>{label}
      <select data-testid={id} value={d[k]} onChange={(e) => set({ [k]: e.target.value as Visibility })}>
        <option value="private">비공개</option><option value="internal">내부</option>
      </select>
    </label>
  );
  return (
    <Card id="defaults" title="기본 공개 범위">
      <p>메모는 늘 비공개다(고정). 만들기 창이 처음 고르는 값만 이 브라우저에 둔다.</p>
      {Select({ id: 'default-document', label: '문서', k: 'document' })}
      {Select({ id: 'default-topic', label: '주제', k: 'topic' })}
    </Card>
  );
}

function AppearanceCard() {
  const a = useAppearance();
  const radio = <T extends string>(name: string, value: T, current: T, label: string, set: (v: T) => void) => (
    <label key={value}><input type="radio" name={name} data-testid={`${name}-${value}`} checked={current === value} onChange={() => set(value)} />{label}</label>
  );
  return (
    <Card id="appearance" title="모양">
      <fieldset><legend>테마</legend>
        {radio<Theme>('theme', 'system', a.theme, '시스템 따름', (theme) => appearance.set({ theme }))}
        {radio<Theme>('theme', 'light', a.theme, '밝게', (theme) => appearance.set({ theme }))}
        {radio<Theme>('theme', 'dark', a.theme, '어둡게', (theme) => appearance.set({ theme }))}
      </fieldset>
      <fieldset><legend>글자 크기</legend>
        {radio<TextSize>('size', 'small', a.size, '작게', (size) => appearance.set({ size }))}
        {radio<TextSize>('size', 'normal', a.size, '보통', (size) => appearance.set({ size }))}
        {radio<TextSize>('size', 'large', a.size, '크게', (size) => appearance.set({ size }))}
      </fieldset>
      <fieldset><legend>홈 그래프</legend>
        {radio<GraphMode>('graph', '3d', a.graph, '3D (기본)', (graph) => appearance.set({ graph }))}
        {radio<GraphMode>('graph', '2d', a.graph, '2D', (graph) => appearance.set({ graph }))}
      </fieldset>
      <label><input type="checkbox" data-testid="motion-reduce" checked={a.motion === 'reduce'} onChange={(e) => appearance.set({ motion: (e.target.checked ? 'reduce' : 'system') as Motion })} />움직임 줄이기</label>
      <p>이 브라우저에만 저장한다.</p>
    </Card>
  );
}
