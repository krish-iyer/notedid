import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { PaperSummary } from '../shared/api.ts';
import { safeDecodeURI, splitFrontmatter } from '../shared/markdown.ts';
import { localISODate } from '../shared/dates.ts';
import { paperStatusOf } from '../shared/papers.ts';
import { slugify, uniqueName } from '../shared/slug.ts';
import { newNoteId, withNoteId } from '../shared/noteIds.ts';
import { stemOf, stringList } from './analyze.ts';
import type { NoteIndex } from './noteIndex.ts';
import { NotFoundError, type NoteService } from './notes.ts';
import { type NoteStore, PathError } from './storage.ts';
import { decodeEntities, type FetchFn, fetchBytes, USER_AGENT } from './web.ts';

export interface PaperMeta {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  arxiv: string | null;
  doi: string | null;
  url: string | null;
  abstract: string | null;
}

/** A failure talking to arXiv or Crossref. */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
}

const MAX_PDF_BYTES = 80 * 1024 * 1024;

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/** Recognises an arXiv link or ID (2501.01234, arXiv:2501.01234v2, hep-th/9901001) or a DOI. */
export function parsePaperId(input: string): { kind: 'arxiv' | 'doi'; id: string } | null {
  const text = safeDecodeURI(input.trim());
  const arxivDoi = /10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?/i.exec(text);
  if (arxivDoi) return { kind: 'arxiv', id: `${arxivDoi[1]}${arxivDoi[2] ?? ''}` };
  const modern = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*|^)(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?(?=$|[?#\s/])/i.exec(text);
  if (modern) return { kind: 'arxiv', id: `${modern[1]}${modern[2] ?? ''}` };
  const old = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*|^)([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?/i.exec(text);
  if (old) return { kind: 'arxiv', id: `${old[1]}${old[2] ?? ''}` };
  const doi = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(text);
  if (doi) return { kind: 'doi', id: (doi[1] ?? '').replace(/[.,;)\]]+$/, '') };
  return null;
}

export function parseArxivFeed(xml: string, id: string): PaperMeta {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry || /<id>[^<]*api\/errors/.test(entry)) throw new NotFoundError(`arXiv has no paper ${id}`);
  const field = (tag: string) => {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
    return match ? decodeEntities(match[1] ?? '').replace(/\s+/g, ' ').trim() || null : null;
  };
  const title = field('title');
  if (!title) throw new NotFoundError(`arXiv has no paper ${id}`);
  return {
    title,
    authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decodeEntities(m[1] ?? '').trim()),
    year: Number(/<published>(\d{4})/.exec(entry)?.[1]) || null,
    venue: field('arxiv:journal_ref') ?? 'arXiv',
    arxiv: id,
    doi: field('arxiv:doi'),
    url: `https://arxiv.org/abs/${id}`,
    abstract: field('summary'),
  };
}

export function parseCrossref(json: unknown, doi: string): PaperMeta {
  const message = ((json as { message?: Record<string, unknown> } | null)?.message ?? {}) as Record<string, unknown>;
  const firstString = (value: unknown) => (Array.isArray(value) ? value.find((v): v is string => typeof v === 'string') : typeof value === 'string' ? value : undefined);
  const title = firstString(message.title)?.replace(/\s+/g, ' ').trim();
  if (!title) throw new NotFoundError(`No paper with DOI ${doi}`);
  const authors = (Array.isArray(message.author) ? message.author : [])
    .map((a: { given?: string; family?: string; name?: string }) => [a.given, a.family].filter(Boolean).join(' ') || a.name || '')
    .filter(Boolean);
  const dateParts = (key: string) => ((message[key] as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0] ?? null);
  const year = dateParts('issued') ?? dateParts('published-print') ?? dateParts('published-online');
  const abstract = typeof message.abstract === 'string' ? decodeEntities(message.abstract.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
  return {
    title,
    authors,
    year: typeof year === 'number' ? year : null,
    venue: firstString(message['container-title']) ?? null,
    arxiv: null,
    doi,
    url: typeof message.URL === 'string' ? message.URL : `https://doi.org/${doi}`,
    abstract,
  };
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'in', 'to', 'with', 'towards', 'toward', 'via', 'is', 'are', 'from']);

/** A short citation-style key: first author's last name, year and first title word, e.g. "vaswani2017attention". */
export function paperKey(meta: PaperMeta): string {
  const last = (meta.authors[0] ?? '').trim().split(/\s+/).pop() ?? '';
  if (!last && !meta.year) return slugify(meta.title); // e.g. an uploaded PDF: just its title
  const word = meta.title.split(/[^\p{L}\p{N}]+/u).find((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase())) ?? '';
  const key = slugify(`${last} ${meta.year ?? ''} ${word}`).replace(/-/g, '');
  return key && key !== 'untitled' ? key : slugify(meta.title);
}

/** The review note for a new paper. */
export function paperNote(meta: PaperMeta, pdfFile: string | null): string {
  const front: Record<string, unknown> = { type: 'paper', title: meta.title };
  if (meta.authors.length) front.authors = meta.authors;
  if (meta.year) front.year = meta.year;
  if (meta.venue) front.venue = meta.venue;
  if (meta.arxiv) front.arxiv = meta.arxiv;
  if (meta.doi) front.doi = meta.doi;
  if (meta.url) front.url = meta.url;
  if (pdfFile) front.pdf = pdfFile;
  front.added = localISODate();
  const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
  const abstract = meta.abstract ? `## Abstract\n\n${meta.abstract}\n\n` : '';
  return `---\n${yaml}\n---\n${abstract}## Summary\n\n## Notes\n\n## Highlights\n`;
}

async function fetchJson(url: string, fetchFn: FetchFn): Promise<{ status: number; body: unknown }> {
  const response = await fetchFn(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

export interface PaperServiceDeps {
  store: NoteStore;
  index: NoteIndex;
  notes: NoteService;
  fetch: FetchFn;
}

/** Papers: a PDF in papers/ plus a review note with its details, highlights and comments. */
export class PaperService {
  readonly #deps: PaperServiceDeps;

  constructor(deps: PaperServiceDeps) {
    this.#deps = deps;
  }

  /** Imports a paper from an arXiv link/ID (with its PDF) or a DOI (details only; add the PDF later). */
  async import(source: string): Promise<{ key: string; path: string; pdf: boolean; existing: boolean }> {
    const id = parsePaperId(source);
    if (!id) throw new PathError('Paste an arXiv link or ID (e.g. 2501.01234) or a DOI (e.g. 10.1145/…)');
    const existing = this.#deps.index
      .list()
      .find((n) => n.kind === 'paper' && String(n.meta[id.kind] ?? '').toLowerCase().replace(/v\d+$/, '') === id.id.toLowerCase().replace(/v\d+$/, ''));
    if (existing) return { key: stemOf(existing.path), path: existing.path, pdf: typeof existing.meta.pdf === 'string', existing: true };

    try {
      if (id.kind === 'arxiv') {
        const feed = await this.#deps.fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id.id)}`, {
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(20_000),
        });
        if (!feed.ok) throw new UpstreamError(`arXiv answered ${feed.status}`);
        const meta = parseArxivFeed(await feed.text(), id.id);
        const file = await fetchBytes(`https://arxiv.org/pdf/${id.id}`, this.#deps.fetch, MAX_PDF_BYTES).catch(() => null);
        const created = await this.#create(meta, file && isPdf(file.bytes) ? file.bytes : null);
        return { ...created, existing: false };
      }
      const { status, body } = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(id.id)}`, this.#deps.fetch);
      if (status === 404) throw new NotFoundError(`No paper with DOI ${id.id}`);
      if (status !== 200) throw new UpstreamError(`Crossref answered ${status}`);
      const created = await this.#create(parseCrossref(body, id.id), null);
      return { ...created, existing: false };
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof UpstreamError || err instanceof PathError) throw err;
      throw new UpstreamError(`Could not reach ${id.kind === 'arxiv' ? 'arXiv' : 'Crossref'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Adds a paper from a PDF file. */
  async upload(fileName: string, bytes: Uint8Array, title?: string): Promise<{ key: string; path: string; pdf: boolean }> {
    if (!isPdf(bytes)) throw new PathError('That file is not a PDF');
    const name = title?.trim() || fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled paper';
    return this.#create({ title: name, authors: [], year: null, venue: null, arxiv: null, doi: null, url: null, abstract: null }, bytes);
  }

  /** Adds or replaces nothing: attaches a PDF to a paper that has none yet. */
  async attachPdf(notePath: string, bytes: Uint8Array): Promise<{ pdf: string }> {
    if (!isPdf(bytes)) throw new PathError('That file is not a PDF');
    const note = this.#deps.index.get(notePath);
    if (!note || note.kind !== 'paper') throw new NotFoundError(`${notePath} is not a paper`);
    if (typeof note.meta.pdf === 'string') throw new PathError('This paper already has a PDF');
    const dir = path.posix.dirname(notePath);
    const stem = stemOf(notePath);
    let pdfName = `${stem}.pdf`;
    for (let n = 2; await this.#deps.store.exists(`${dir}/${pdfName}`); n++) pdfName = `${stem}-${n}.pdf`;
    await this.#deps.store.createBytes(`${dir}/${pdfName}`, bytes);
    await this.#deps.notes.update(notePath, (content) => {
      const { bodyOffset } = splitFrontmatter(content);
      if (bodyOffset === 0) return `---\npdf: ${pdfName}\n---\n${content}`;
      const front = content.slice(0, bodyOffset);
      const closing = front.lastIndexOf('---');
      return `${front.slice(0, closing)}pdf: ${pdfName}\n${front.slice(closing)}${content.slice(bodyOffset)}`;
    });
    return { pdf: `${dir}/${pdfName}` };
  }

  async #create(meta: PaperMeta, pdf: Uint8Array | null): Promise<{ key: string; path: string; pdf: boolean }> {
    const taken = new Set(this.#deps.index.paths());
    const key = uniqueName(paperKey(meta), (k) => taken.has(`papers/${k}.md`));
    const pdfName = pdf ? `${key}.pdf` : null;
    if (pdf) await this.#deps.store.createBytes(`papers/${pdfName}`, pdf);
    const notePath = `papers/${key}.md`;
    await this.#deps.notes.save(notePath, withNoteId(paperNote(meta, pdfName), newNoteId()), null);
    return { key, path: notePath, pdf: pdf !== null };
  }

  async list(): Promise<PaperSummary[]> {
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const papers = this.#deps.index.list().filter((n) => n.kind === 'paper');
    return Promise.all(
      papers.map(async (n) => {
        const dir = path.posix.dirname(n.path);
        const key = stemOf(n.path);
        const pdf = typeof n.meta.pdf === 'string' ? `${dir}/${n.meta.pdf}` : null;
        let highlights = 0;
        try {
          const doc = await this.#deps.store.readText(`${dir}/${key}.highlights.json`);
          const data: unknown = doc.hash ? JSON.parse(doc.content) : [];
          highlights = Array.isArray(data) ? data.length : 0;
        } catch {
          highlights = 0;
        }
        return {
          key,
          path: n.path,
          title: n.title,
          authors: stringList(n.meta.authors),
          year: Number(n.meta.year) || null,
          venue: typeof n.meta.venue === 'string' && n.meta.venue.trim() ? n.meta.venue.trim() : null,
          status: paperStatusOf(n.meta.status),
          tags: n.tags,
          metaTags: [...stringList(n.meta.tags), ...stringList(n.meta.tag)].map((t) => t.replace(/^#/, '').toLowerCase()),
          doi: text(n.meta.doi),
          arxiv: text(n.meta.arxiv),
          url: text(n.meta.url),
          added: /^\d{4}-\d{2}-\d{2}/.test(String(n.meta.added ?? '')) ? String(n.meta.added).slice(0, 10) : null,
          pdf,
          highlights,
          mtime: n.mtime,
        };
      }),
    );
  }
}
