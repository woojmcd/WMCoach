// The repo on disk as the { read, list } interface coach/routine.js expects.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function diskRepo(root) {
  return {
    root,
    read(path) {
      try { return readFileSync(join(root, path), 'utf8'); } catch { return null; }
    },
    // every file under a directory prefix ("data/strava/"), as repo-relative paths
    list(prefix) {
      const dir = join(root, prefix);
      const out = [];
      const walk = (d, rel) => {
        let names = [];
        try { names = readdirSync(d); } catch { return; }
        for (const n of names.sort()) {
          const full = join(d, n);
          if (statSync(full).isDirectory()) walk(full, `${rel}${n}/`);
          else out.push(`${rel}${n}`);
        }
      };
      walk(dir, prefix);
      return out;
    },
    exists(path) { return existsSync(join(root, path)); },
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
  };
}
