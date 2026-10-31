// Honest wording for every failure the contract names (design 7.4). The code stays visible: it is what a person would search for.
import { KbProblem, KbUnavailable } from '../data/kbFetch.ts';

export type ErrorInfo = { title: string; detail: string; code: string | null; hidden: boolean; retry: boolean };

const proxyHelp: Record<string, string> = {
  kb_socket_missing: 'KB 소켓이 없다. KB가 설치되지 않았거나 아직 뜨지 않았다.',
  kb_socket_refused: '소켓 파일은 있지만 듣는 프로세스가 없다. KB가 멈췄다.',
  kb_socket_denied: '소켓 권한이 맞지 않는다. 설정 오류라 다시 시도해도 같다.',
  kb_timeout: 'KB가 제한 시간 안에 답하지 않았다.',
  kb_upstream_error: 'KB 연결이 끊겼다.',
};

export function describeError(e: unknown): ErrorInfo {
  if (e instanceof KbUnavailable) {
    const code = e.code ?? null;
    if (code && proxyHelp[code]) return { title: 'KB 사용 불가', detail: proxyHelp[code]!, code, hidden: false, retry: code !== 'kb_socket_denied' };
    return { title: 'KB 사용 불가', detail: e.reason === 'timeout' ? 'KB가 제한 시간 안에 답하지 않았다. WSL이 멈췄을 수 있다.' : 'loupe 서버에 닿지 않는다. WSL이 멈췄을 수 있다.', code, hidden: false, retry: true };
  }
  if (e instanceof KbProblem) {
    const code = e.code ?? null;
    const of = (title: string, detail: string, retry = false): ErrorInfo => ({ title, detail, code, hidden: false, retry });
    switch (e.status) {
      // Absent and hidden are the same answer on purpose (C 2.7).
      case 404: return { title: '없거나 볼 수 없음', detail: '이 ID는 없거나 지금 범위에서 볼 수 없다.', code, hidden: true, retry: false };
      case 410: return code === 'content_removed' ? of('본문이 삭제됐다', '메타데이터는 남아 있고 본문은 지워졌다.') : of('데이터 세대가 바뀌었다', '처음부터 다시 읽어야 한다.', true);
      case 429: return of('요청이 몰렸다', 'KB의 동시 요청 상한을 넘었다. 잠시 뒤 다시 시도한다.', true);
      case 503: return code === 'read_timeout' ? of('KB 읽기 시간 초과', 'KB는 살아 있고 이 요청만 상한을 넘었다.', true) : of('KB가 시작하는 중이다', '잠시 뒤 다시 시도한다.', true);
      case 401: case 403: return of('설정 오류', '토큰이나 Host 설정이 KB와 맞지 않는다.');
      case 400:
        if (code === 'cursor_mismatch') return of('처음부터 다시 읽어야 한다', '이어 읽던 위치가 지금 조건과 맞지 않는다.', true);
        return of('KB가 요청을 거절했다', e.problem.detail ?? e.message);
      default:
        if (code === 'as_of_mismatch') return of('시점을 확인할 수 없다', 'KB가 답한 시점이 요청과 다르다. 다른 시점의 데이터를 이 기준으로 보여 주지 않는다.');
        return of('KB 오류', e.problem.detail ?? e.message, true);
    }
  }
  return { title: '화면을 그리지 못했다', detail: e instanceof Error ? e.message : String(e), code: null, hidden: false, retry: false };
}
