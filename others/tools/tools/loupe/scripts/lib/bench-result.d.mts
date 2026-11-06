export function parseBenchResult(body: string): { ok: true; line: string } | { ok: false; reason: string };
