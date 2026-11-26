/**
 * BibTeX for papers in the library: one entry per paper, from the details in its review note.
 * arXiv preprints become @misc with an eprint, proceedings @inproceedings, journals @article.
 */

export interface BibSource {
  key: string;
  title: string;
  authors: readonly string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxiv: string | null;
  url: string | null;
}

/** BibTeX keys: letters, digits and a few marks; anything else becomes "-". */
export function bibtexKey(key: string): string {
  return key.replace(/[^\w:.-]+/g, '-').replace(/^-+|-+$/g, '') || 'paper';
}

/** Characters LaTeX would read as commands, escaped. */
function escape(value: string): string {
  return value.replace(/\\/g, '\\textbackslash{}').replace(/([&%#$_])/g, '\\$1').replace(/[{}]/g, '');
}

const PROCEEDINGS = /proceedings|conference|symposium|workshop|\bconf\b|\bproc\b/i;

export function toBibtex(paper: BibSource): string {
  const venue = paper.venue && !/^arxiv$/i.test(paper.venue.trim()) ? paper.venue.trim() : null;
  const type = venue ? (PROCEEDINGS.test(venue) ? 'inproceedings' : 'article') : 'misc';
  const fields: [string, string][] = [
    // Double braces keep the title's capitals (BibTeX styles lower-case them otherwise).
    ['title', `{${escape(paper.title)}}`],
    ['author', paper.authors.map(escape).join(' and ')],
    ['year', paper.year ? String(paper.year) : ''],
    [type === 'inproceedings' ? 'booktitle' : 'journal', venue ? escape(venue) : ''],
    ['doi', paper.doi ?? ''],
    ['eprint', paper.arxiv ?? ''],
    ['archiveprefix', paper.arxiv ? 'arXiv' : ''],
    ['url', paper.url ?? (paper.arxiv ? `https://arxiv.org/abs/${paper.arxiv}` : paper.doi ? `https://doi.org/${paper.doi}` : '')],
  ];
  const body = fields
    .filter(([, value]) => value)
    .map(([name, value]) => `  ${name} = {${value}}`)
    .join(',\n');
  return `@${type}{${bibtexKey(paper.key)},\n${body}\n}\n`;
}
