import { PathLike } from 'node:fs';
import fs, { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'path';
import { findUp, pathExists } from 'find-up';
import packlist from 'npm-packlist';
import { packageDirectory } from 'pkg-dir';
import type { JsonValue } from 'type-fest';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({}, { context: { name: 'utils' } });

export function inlineTryCatch<T, Y>(
  fn: () => T,
  onReject: (err: unknown) => Y,
): T | Y {
  try {
    return fn();
  } catch (err) {
    return onReject(err);
  }
}

packlist({});

export function maybeMakeAbsolute(entry: string, baseDir: string): string {
  if (isAbsolute(entry)) {
    return entry;
  }
  return resolvePath(baseDir, entry);
}

export function dedupeArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export async function serialPromiseMap<T extends Array<unknown>, R>(
  arr: T,
  fn: (value: T[0], idx: number) => Promise<R>,
) {
  const results: Awaited<ReturnType<typeof fn>>[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const value of arr) {
    // using `results.length` might seem hacky, but as we intrinsicly push
    // on each loop, it will always provide the correct index
    results.push(await fn(value, results.length));
  }
  return results;
}

export function relativeFileUrl(from: URL, to: URL): string {
  return relative(fileURLToPath(from), fileURLToPath(to));
}

// create a function that will definitely run at least once, every `delay` seconds
export function basicThrottle<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
) {
  let callable = true;
  return (...args: Parameters<T>): void => {
    if (callable) {
      callable = false;
      setTimeout(() => {
        callable = true;
      }, delay);
      callback(...args);
    }
  };
}

// create a function that will run at least once `delay` seconds after the last call

export function basicDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
) {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}

export async function readJsonFile<T = JsonValue>(file: URL): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export async function recursiveReaddir(dir: PathLike): Promise<PathLike[]> {
  const paths = await readdir(dir);
  const files = await Promise.all(
    paths.flatMap(async (path) => {
      const absPath = new URL(`./${path}`, dir.toString());
      console.log({ path, dir: dir.toString(), absPath: absPath.toString() });
      const stats = await stat(absPath);
      if (stats.isDirectory()) {
        return recursiveReaddir(`${absPath}/`);
      }
      return [absPath];
    }),
  );

  return files.flat();
}

export async function dirSize(
  dir: PathLike,
): Promise<[files: number, size: number]> {
  const files = await recursiveReaddir(
    !dir.toString().endsWith('/') ? `${dir.toString()}/` : dir,
  );
  const size = await files.reduce(async (accum, file) => {
    const total = await accum;
    const stats = await stat(file);
    return total + stats.size;
  }, Promise.resolve(0));

  return [files.length, size];
}

export function partitionArray<T>(
  arr: T[],
  predicate: (value: T, idx: number) => boolean,
): [T[], T[]] {
  return arr.reduce<[T[], T[]]>(
    ([met, unmet], elem, idx): [T[], T[]] =>
      predicate(elem, idx) ? [[...met, elem], unmet] : [met, [...unmet, elem]],
    [[], []],
  );
}
