import { describe, expect, it } from 'vitest';
import { frontmatterField, frontmatterLines, setFrontmatterField } from './frontmatter.ts';
import { paperStatusOf } from './papers.ts';

const PAPER = ['---', 'type: paper', "title: 'Title: with quotes'", 'authors:', '  - A. Author', '  - B. Author', 'year: 2017', '---', '## Summary', ''].join('\n');

describe('front matter fields', () => {
  it('finds the block', () => {
    expect(frontmatterLines(PAPER.split('\n'))).toEqual({ open: 0, close: 7 });
    expect(frontmatterLines(['# no front matter', '---'])).toBeNull();
    expect(frontmatterLines(['---', 'never closed'])).toBeNull();
  });

  it('reads plain and quoted values', () => {
    expect(frontmatterField(PAPER, 'title')).toBe('Title: with quotes');
    expect(frontmatterField(PAPER, 'year')).toBe('2017');
    expect(frontmatterField(PAPER, 'status')).toBeNull();
    expect(frontmatterField('---\nstatus: "reading" \n---\n', 'status')).toBe('reading');
    expect(frontmatterField('---\nstatus: read # finished in May\n---\n', 'status')).toBe('read');
    expect(frontmatterField('status: read\n', 'status')).toBeNull();
  });

  it('adds a field before the closing line and changes only that line', () => {
    const added = setFrontmatterField(PAPER, 'status', 'reading');
    expect(added).toBe(PAPER.replace('year: 2017\n---', 'year: 2017\nstatus: reading\n---'));
    expect(setFrontmatterField(added, 'status', 'read')).toBe(PAPER.replace('year: 2017\n---', 'year: 2017\nstatus: read\n---'));
    expect(setFrontmatterField(added, 'status', null)).toBe(PAPER);
  });

  it('replaces a list value with its items', () => {
    expect(setFrontmatterField(PAPER, 'authors', 'Someone')).toBe(PAPER.replace('authors:\n  - A. Author\n  - B. Author', 'authors: Someone'));
  });

  it('quotes values YAML would misread', () => {
    expect(setFrontmatterField(PAPER, 'note', 'yes')).toContain('note: "yes"\n');
    expect(setFrontmatterField(PAPER, 'note', 'a: b')).toContain('note: "a: b"\n');
    expect(setFrontmatterField(PAPER, 'note', '2024')).toContain('note: "2024"\n');
    expect(setFrontmatterField(PAPER, 'year', 2018)).toContain('\nyear: 2018\n');
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    const crlf = '\uFEFF---\r\ntype: paper\r\n---\r\nBody\r\n';
    expect(setFrontmatterField(crlf, 'status', 'read')).toBe('\uFEFF---\r\ntype: paper\r\nstatus: read\r\n---\r\nBody\r\n');
    expect(setFrontmatterField('Body\r\n', 'status', 'read')).toBe('---\r\nstatus: read\r\n---\r\nBody\r\n');
    expect(setFrontmatterField('\uFEFFBody\n', 'status', 'read')).toBe('\uFEFF---\nstatus: read\n---\nBody\n');
  });

  it('leaves a note alone when removing a field it does not have', () => {
    expect(setFrontmatterField('Body\n', 'status', null)).toBe('Body\n');
    expect(setFrontmatterField(PAPER, 'status', null)).toBe(PAPER);
  });
});

describe('paper status', () => {
  it('reads the status, with "to read" as the default', () => {
    expect(paperStatusOf('reading')).toBe('reading');
    expect(paperStatusOf('Read')).toBe('read');
    expect(paperStatusOf('done')).toBe('read');
    expect(paperStatusOf('to read')).toBe('to-read');
    expect(paperStatusOf(undefined)).toBe('to-read');
    expect(paperStatusOf('someday')).toBe('to-read');
  });
});

describe('front matter lists', () => {
  it('writes lists, replacing whatever form was there, and removes empty ones', () => {
    const withTags = setFrontmatterField(PAPER, 'tags', ['fpga', 'hls']);
    expect(withTags).toContain('year: 2017\ntags:\n  - fpga\n  - hls\n---\n');
    expect(setFrontmatterField('---\ntags: [a]\n---\nBody\n', 'tags', ['a', 'b'])).toBe('---\ntags:\n  - a\n  - b\n---\nBody\n');
    expect(setFrontmatterField(withTags, 'tags', [])).toBe(PAPER);
    expect(setFrontmatterField(PAPER, 'authors', ['Only One'])).toContain('authors:\n  - Only One\nyear: 2017');
    expect(setFrontmatterField('---\r\na: 1\r\n---\r\n', 'tags', ['x'])).toBe('---\r\na: 1\r\ntags:\r\n  - x\r\n---\r\n');
  });
});
