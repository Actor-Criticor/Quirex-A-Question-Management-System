/**
 * api.ts — 路由层公共工具
 */

import { NextResponse } from 'next/server';
import { NotFoundError, ValidationError } from './service';

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(e: unknown): NextResponse {
  if (e instanceof ValidationError) {
    return NextResponse.json(
      { error: e.message, field: e.field, hint: e.hint },
      { status: 400 }
    );
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: e.message }, { status: 404 });
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error('[api]', e);
  return NextResponse.json({ error: message || '服务器错误' }, { status: 500 });
}

/** 安全地把请求体解析成对象 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 解析「可重复出现的查询参数」为字符串数组 */
export function queryList(sp: URLSearchParams, key: string): string[] {
  return sp
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function queryNumber(sp: URLSearchParams, key: string): number | undefined {
  const raw = sp.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
