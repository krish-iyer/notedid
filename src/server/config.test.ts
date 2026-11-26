import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('defaults to a dev notes folder inside the repo, on localhost', () => {
    const config = loadConfig({});
    expect(config.notesDir).toBe(path.resolve('dev-notes'));
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4321);
    expect(config.allowedOrigins).toContain('http://localhost:4322');
  });

  it('requires NOTES_DIR in production and allows no dev origins there', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/NOTES_DIR/);
    const config = loadConfig({ NODE_ENV: 'production', NOTES_DIR: '/srv/notes' });
    expect(config.allowedOrigins).toEqual(['http://localhost:4321', 'http://127.0.0.1:4321']);
  });

  it('refuses to listen beyond localhost until login exists', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/only listens on localhost/);
    expect(() => loadConfig({ HOST: '192.168.1.10' })).toThrow(/only listens on localhost/);
  });

  it('validates ports and follows WEB_PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ WEB_PORT: '70000' })).toThrow(/WEB_PORT/);
    expect(loadConfig({ WEB_PORT: '5000' }).allowedOrigins).toContain('http://127.0.0.1:5000');
  });

  it('expands ~ in NOTES_DIR', () => {
    expect(loadConfig({ NOTES_DIR: '~/notes' }).notesDir).toBe(path.join(os.homedir(), 'notes'));
  });
});
