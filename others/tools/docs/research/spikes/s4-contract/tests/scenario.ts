import { QueryClient } from '@tanstack/react-query';
export async function run(name: string, cases: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const [label, opts] of Object.entries(cases)) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const d: any = await qc.fetchQuery(opts);
      out[label] = { resolved: true, keys: Object.keys(d ?? {}).join(','), status: d?.status, problemInData: d?.data?.title ?? d?.title, hangul: d?.data?.[0]?.label ?? d?.data?.data?.[0]?.label ?? d?.data?.label ?? d?.data?.data?.label };
    } catch (e: any) {
      out[label] = { rejected: true, ctor: e?.constructor?.name, keys: Object.keys(e ?? {}).join(','), status: e?.status ?? e?.response?.status, code: e?.code ?? e?.error?.code ?? e?.data?.code, msg: String(e?.message ?? '').slice(0, 80) };
    }
  }
  console.log(JSON.stringify({ name, out }, null, 0));
}
