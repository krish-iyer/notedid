import { describe, expect, it } from 'vitest';
import { merge3 } from './merge3.ts';

const base = '# Plan\n\nIntro line.\n\n## Monday\nCall the lab.\n\n## Friday\nWrite the report.\n';

describe('three-way merge', () => {
  it('takes changes made in different places from both sides', () => {
    const ours = base.replace('Intro line.', 'Intro line, edited on the laptop.');
    const theirs = base.replace('Write the report.', 'Write the report and send it.');
    expect(merge3(base, ours, theirs)).toEqual({ text: '# Plan\n\nIntro line, edited on the laptop.\n\n## Monday\nCall the lab.\n\n## Friday\nWrite the report and send it.\n', clean: true });
  });

  it('takes one side when only it changed, and a change made on both sides once', () => {
    const changed = base.replace('Call the lab.', 'Call the lab at 10.');
    expect(merge3(base, base, changed)).toEqual({ text: changed, clean: true });
    expect(merge3(base, changed, base)).toEqual({ text: changed, clean: true });
    expect(merge3(base, changed, changed)).toEqual({ text: changed, clean: true });
    const both = changed.replace('Intro line.', 'Intro.');
    expect(merge3(base, both, changed.replace('Write the report.', 'Write it.'))).toEqual({ text: both.replace('Write the report.', 'Write it.'), clean: true });
  });

  it('keeps lines both sides added at the same place, ours first', () => {
    const journal = '# 2026-11-26\n\n- 09:00 Standup\n';
    expect(merge3(journal, `${journal}- 10:15 From the laptop\n`, `${journal}- 10:20 From the phone\n`)).toEqual({ text: `${journal}- 10:15 From the laptop\n- 10:20 From the phone\n`, clean: true });
  });

  it('is not clean when both changed the same lines differently, and keeps ours there', () => {
    const ours = base.replace('Call the lab.', 'Call the lab at 10.');
    const theirs = base.replace('Call the lab.', 'Email the lab.').replace('Intro line.', 'Intro.');
    expect(merge3(base, ours, theirs)).toEqual({ text: ours.replace('Intro line.', 'Intro.'), clean: false });
  });

  it('handles a last line without a line break, and deleted lines', () => {
    expect(merge3('a\nb', 'a\nb\nc', 'z\nb')).toEqual({ text: 'z\nb\nc', clean: true });
    expect(merge3('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\nd\n')).toEqual({ text: 'a\nc\nd\n', clean: true });
    expect(merge3('', 'x\n', 'y\n')).toEqual({ text: 'x\ny\n', clean: true });
    expect(merge3('a\nb\nc\nd\n', 'b\nc\nd\n', 'a\nb\nc\nd\ne\n')).toEqual({ text: 'b\nc\nd\ne\n', clean: true });
    // A deleted line next to a line added on the other side: which comes first is unclear.
    expect(merge3('a\n', '', 'a\nb\n').clean).toBe(false);
  });
});
