import { describe, expect, it } from 'vitest';
import { bibtexKey, toBibtex } from './bibtex.ts';

const BASE = { key: 'vaswani2017attention', title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, venue: null, doi: null, arxiv: null, url: null };

describe('bibtex', () => {
  it('writes an arXiv preprint as @misc with its eprint', () => {
    expect(toBibtex({ ...BASE, venue: 'arXiv', arxiv: '1706.03762' })).toBe(
      [
        '@misc{vaswani2017attention,',
        '  title = {{Attention Is All You Need}},',
        '  author = {Ashish Vaswani and Noam Shazeer},',
        '  year = {2017},',
        '  eprint = {1706.03762},',
        '  archiveprefix = {arXiv},',
        '  url = {https://arxiv.org/abs/1706.03762}',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('chooses @inproceedings or @article from the venue', () => {
    expect(toBibtex({ ...BASE, venue: 'Proceedings of EuroSys 2027', doi: '10.1145/1' })).toMatch(/^@inproceedings\{[\s\S]*booktitle = \{Proceedings of EuroSys 2027\}[\s\S]*doi = \{10\.1145\/1\}/);
    expect(toBibtex({ ...BASE, venue: 'Communications of the ACM' })).toMatch(/^@article\{[\s\S]*journal = \{Communications of the ACM\}/);
  });

  it('escapes LaTeX specials and leaves out empty fields', () => {
    const entry = toBibtex({ ...BASE, key: 'reconfig study #3', title: 'Speed & 100% {fun}_now', authors: [], year: null });
    expect(entry).toContain('@misc{reconfig-study-3,');
    expect(entry).toContain('title = {{Speed \\& 100\\% fun\\_now}}');
    expect(entry).not.toContain('author');
    expect(entry).not.toContain('year');
    expect(bibtexKey('***')).toBe('paper');
  });
});
