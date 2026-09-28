/**
 * Local-filesystem ObjectStorageClient (VWAP_STORAGE_MIGRATION_PLAN.md §3)
 * — explicitly for development/tests only, per your own stated scope.
 * NOT the production backend — see that file for why Supabase
 * Storage/S3/R2 aren't available yet and what's needed to unblock one of
 * them.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ObjectStorageClient } from './barArchiveStore.ts';

export function createLocalObjectStorage(rootDir: string): ObjectStorageClient {
  const resolve = (p: string) => path.join(rootDir, p);

  return {
    async upload(objectPath, localFilePath) {
      try {
        const dest = resolve(objectPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(localFilePath, dest);
        return { ok: true };
      } catch (err: any) {
        return { error: err.message };
      }
    },
    async download(objectPath, localFilePath) {
      const src = resolve(objectPath);
      if (!fs.existsSync(src)) return { error: 'not found', notFound: true };
      try {
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
        fs.copyFileSync(src, localFilePath);
        return { ok: true };
      } catch (err: any) {
        return { error: err.message };
      }
    },
    async list(prefix) {
      try {
        const base = resolve(prefix);
        if (!fs.existsSync(base)) return { ok: true, paths: [] };
        const out: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(path.relative(rootDir, full));
          }
        };
        walk(base);
        return { ok: true, paths: out };
      } catch (err: any) {
        return { error: err.message };
      }
    },
    async exists(objectPath) {
      return fs.existsSync(resolve(objectPath));
    },
  };
}
