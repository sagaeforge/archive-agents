import { QueryClient } from '@tanstack/react-query';
export async function runInf(name: string, opts: any) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r: any = await qc.fetchInfiniteQuery({ ...opts, pages: 5 });
  const rows = r.pages.flatMap((p: any) => p.data.map((e: any) => e.id));
  console.log(JSON.stringify({ name, pages: r.pages.length, rows, params: r.pageParams }));
}
