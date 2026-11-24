import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LICENSE_FILES } from '../vite.config';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  license: string;
  dependencies: Record<string, string>;
};

describe('licensing', () => {
  it('Packet Flip is MIT licensed', () => {
    expect(pkg.license).toBe('MIT');
    expect(readFileSync('LICENSE', 'utf8')).toMatch(/^MIT License/);
  });

  it('every license the site ships exists and is non-empty', () => {
    for (const [published, src] of Object.entries(LICENSE_FILES)) {
      expect(readFileSync(src, 'utf8').length, `${published} ← ${src}`).toBeGreaterThan(200);
    }
  });

  it('every runtime dependency has its license shipped and is listed in the notices', () => {
    const shipped = Object.values(LICENSE_FILES);
    const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(shipped, `${name} license is not shipped`).toContain(`node_modules/${name}/LICENSE`);
      expect(notices, `${name} ${version} missing from THIRD_PARTY_NOTICES.md`).toContain(version);
    }
  });
});
