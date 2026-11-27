import { describe, expect, it } from 'vitest';
import { analyzeNote } from '../server/analyze.ts';
import { emptyWhiteboard, frameNames, isWhiteboardContent, isWhiteboardPath, whiteboardFileStem, whiteboardIndexText, whiteboardName } from './whiteboards.ts';

/** A drawing as Excalidraw saves one, with only the fields that matter here. */
function scene(elements: Record<string, unknown>[]): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} });
}

const drawing = scene([
  { id: 'f1', type: 'frame', name: 'Architecture' },
  { id: 'f2', type: 'frame', name: null },
  { id: 't1', type: 'text', text: 'Load balancer', originalText: 'Load balancer', frameId: 'f1' },
  { id: 't2', type: 'text', text: 'Ideas from\n[[Groceries]] #idea', originalText: 'Ideas from\n[[Groceries]] #idea', frameId: null },
  { id: 't3', type: 'text', text: 'gone', originalText: 'gone', isDeleted: true },
  { id: 't4', type: 'text', text: '# not a heading', originalText: '# not a heading', frameId: 'f2' },
  { id: 't5', type: 'text', text: '- [ ] not a task', originalText: '- [ ] not a task', frameId: null },
  { id: 'r1', type: 'rectangle', link: 'https://example.com/spec' },
  { id: 'r2', type: 'ellipse', link: '[[Meeting notes]]' },
  { id: 'f3', type: 'frame', name: 'Architecture' },
  { id: 'f4', type: 'frame', name: 'Old one', isDeleted: true },
]);

describe('whiteboard files', () => {
  it('names them by their file', () => {
    expect(isWhiteboardPath('whiteboards/Project plan.excalidraw')).toBe(true);
    expect(isWhiteboardPath('notes/a.md')).toBe(false);
    expect(isWhiteboardPath('.excalidraw')).toBe(false);
    expect(whiteboardName('whiteboards/Project plan.excalidraw')).toBe('Project plan');
  });

  it('makes file names from titles, keeping what files and links can take', () => {
    expect(whiteboardFileStem('  Project plan  ')).toBe('Project plan');
    expect(whiteboardFileStem('Q3: plan/ideas #1 [draft]')).toBe('Q3 plan ideas 1 draft');
    expect(whiteboardFileStem('...hidden')).toBe('hidden');
    expect(whiteboardFileStem('///')).toBe('Whiteboard');
  });

  it('starts with an empty drawing Excalidraw can open', () => {
    const empty = JSON.parse(emptyWhiteboard());
    expect(empty).toMatchObject({ type: 'excalidraw', version: 2, elements: [] });
    expect(isWhiteboardContent(emptyWhiteboard())).toBe(true);
    expect(isWhiteboardContent('{"elements": 3}')).toBe(false);
    expect(isWhiteboardContent('not json')).toBe(false);
  });
});

describe('a whiteboard in the index', () => {
  it('lists the named frames, once each, without deleted ones', () => {
    expect(frameNames(drawing)).toEqual(['Architecture']);
  });

  it('is the text on it, each named frame a heading over its own text, and the links on its shapes', () => {
    const text = whiteboardIndexText(drawing, 'Project plan');
    expect(text).toContain('type: whiteboard');
    expect(text).toContain('title: "Project plan"');
    expect(text).toContain('## Architecture\n\nLoad balancer');
    expect(text).toContain('[[Groceries]] #idea');
    expect(text).toContain('\\# not a heading');
    expect(text).toContain('<https://example.com/spec>');
    expect(text).toContain('[[Meeting notes]]');
    expect(text).not.toContain('gone');
    expect(text).not.toContain('Old one');
  });

  it('reads as a note of its own kind: its links, tags and frames, and no tasks', () => {
    const a = analyzeNote('whiteboards/Project plan.excalidraw', whiteboardIndexText(drawing, 'Project plan'));
    expect(a.kind).toBe('whiteboard');
    expect(a.title).toBe('Project plan');
    expect(a.links.map((l) => l.target)).toEqual(expect.arrayContaining(['Groceries', 'Meeting notes', 'https://example.com/spec']));
    expect(a.tags).toContain('idea');
    expect(a.headings.map((h) => h.text)).toEqual(['Architecture']);
    expect(a.tasks).toEqual([]);
  });

  it('copes with a file that isn’t a drawing', () => {
    expect(whiteboardIndexText('{oops', 'Broken')).toContain('title: "Broken"');
    expect(frameNames('{oops')).toEqual([]);
  });
});
