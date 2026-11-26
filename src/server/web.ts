/** Small helpers for fetching things from the web on the user's behalf. */

export type FetchFn = typeof fetch;

export const USER_AGENT = 'notedid/0.1 (personal notes app)';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Reads at most `maxBytes` of a response body as text. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/** The title of a web page (og:title or <title>), or null. Only http(s); gives up after a few seconds. */
export async function fetchPageTitle(url: string, fetchFn: FetchFn = fetch): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  try {
    const response = await fetchFn(parsed, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok || !/html|xml/i.test(response.headers.get('content-type') ?? '')) return null;
    const html = await readLimited(response, 512 * 1024);
    const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
    const title = og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const clean = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '';
    return clean ? clean.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** Downloads a file, refusing anything bigger than `maxBytes`. */
export async function fetchBytes(url: string, fetchFn: FetchFn, maxBytes: number, timeoutMs = 60_000): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const response = await fetchFn(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1e6)} MB`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1e6)} MB`);
  return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' };
}
