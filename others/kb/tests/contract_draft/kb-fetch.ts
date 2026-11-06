// Orval mutator 자리. 생성물 타입 검사용 최소 구현이다(소비자 구현은 loupe가 소유).
export const kbFetch = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const res = await fetch(url, options);
  const body = [204, 205, 304].includes(res.status) ? null : await res.text();
  const data = body ? JSON.parse(body) : {};
  return data as T;
};
export default kbFetch;
