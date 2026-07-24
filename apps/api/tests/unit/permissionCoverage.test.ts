import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Permission, ROLE_PERMISSIONS } from '../../src/modules/authz/permissions.js';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('permission catalog coverage', () => {
  const granted = new Set(Object.values(ROLE_PERMISSIONS).flatMap((list) => [...list]));

  it('has no duplicate permission values', () => {
    // A duplicated key in the catalog object silently keeps only the last value. This is a
    // regression test: a stale duplicate block once dropped SHOP_UPDATE_OWN from the owner
    // role, which would have made shop owners unable to edit their own shop.
    const values = Object.values(Permission);
    expect(new Set(values).size).toBe(values.length);
  });

  it('grants every declared permission to at least one role', () => {
    const orphans = Object.values(Permission).filter((permission) => !granted.has(permission));
    expect(orphans, `unreachable permissions: ${orphans.join(', ')}`).toEqual([]);
  });

  it('grants every permission the routes actually require', () => {
    // Parses `requirePermission(Permission.X)` out of every route file, so a route can never
    // demand a key that no role holds.
    const required = new Set<string>();
    for (const file of sourceFiles(join(process.cwd(), 'apps/api/src/modules'))) {
      if (!file.endsWith('.routes.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/requirePermission\(([^)]*)\)/g)) {
        for (const reference of (match[1] ?? '').matchAll(/Permission\.([A-Z_]+)/g)) {
          const key = reference[1];
          if (key) required.add(key);
        }
      }
    }
    expect(required.size).toBeGreaterThan(5);

    const catalog = Permission as unknown as Record<string, string>;
    for (const key of required) {
      expect(catalog[key], `Permission.${key} is referenced by a route but not declared`).toBeDefined();
      const value = catalog[key];
      if (value) {
        expect(granted.has(value as never), `Permission.${key} is required by a route but granted to no role`).toBe(true);
      }
    }
  });
});
