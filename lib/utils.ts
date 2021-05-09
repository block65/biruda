import fs from 'fs/promises';
import { createRequire } from 'module';
import { dirname, isAbsolute, relative, resolve } from 'path';
import pkgUp from 'pkg-up';
import type { AsyncReturnType, JsonValue } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';

import { readManifest } from './deps.js';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ name: 'utils' });

export function maybeMakeAbsolute(entry: string, baseDir: string): string {
  if (isAbsolute(entry)) {
    return entry;
  }
  return resolve(baseDir, entry);
}

export function dedupeArray<T extends any>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// async for future esm compat
export async function resolvePackageJson(
  name: string,
  base: URL,
): Promise<URL> {
  const require = createRequire(base);

  try {
    return pathToFileURL(
      require.resolve(`${name}/package.json`, {
        paths: [base.pathname],
      }),
    );
  } catch (err) {
    if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      if (logger.isLevelEnabled('debug')) {
        logger.warn({ base, name }, 'WARN: %s', err.message);
      }

      const path = await pkgUp({
        cwd: dirname(
          require.resolve(name, {
            paths: [base.pathname],
          }),
        ),
      });

      if (path === null) {
        throw new Error(`Unable to resolve path $path`);
      }

      return pathToFileURL(path);
    }
    throw err;
  }
}

export async function getDependencyPathsFromModule(
  name: string,
  base: URL,
  descendCallback: (path: URL, name: string) => boolean,
  includeCallback: (path: URL, name: string) => void,
  parents: string[] = [],
): Promise<void> {
  const logPrefixString = [name, parents].join('->');

  logger.debug('[%s] Resolving deps', logPrefixString, name);
  const modulePath = await resolvePackageJson(name, base);

  if (!descendCallback(modulePath, name)) {
    return;
  }

  const pkgJson = await readManifest(modulePath);

  if (!pkgJson) {
    throw new Error(`Unable to locate manifest for ${name}`);
  }

  includeCallback(new URL('package.json', modulePath), name);

  dedupeArray([
    // 'package.json',
    // 'LICENSE',
    // 'LICENSE.md',
    ...(pkgJson.files || []),
  ]).forEach((glob) => {
    includeCallback(new URL(glob, modulePath), name);
  });

  if (pkgJson.main) {
    includeCallback(new URL(pkgJson.main, modulePath), name);
  }

  if (!pkgJson.files) {
    logger.trace('[%s] No files[] in  manifest, adding all', logPrefixString);
    includeCallback(modulePath, name);
  }

  const dependencies = Object.keys(pkgJson.dependencies || {});

  logger.trace(
    '[%s] Found %d deps',
    logPrefixString,
    Object.keys(dependencies).length,
  );

  // at leaf node
  if (dependencies.length === 0) {
    // callback(modulePath);
    return; // [modulePath];
  }

  dependencies.forEach((pkgDep) => {
    // logger.trace('[%s] Found dep %s', pkgDep, name);
    getDependencyPathsFromModule(
      pkgDep,
      modulePath,
      descendCallback,
      includeCallback,
      [...parents, name],
    );
  });
}

export function serialPromiseMapAccum<
  T,
  F extends (arg: T, idx: number, arr: T[]) => Promise<any> = (
    arg: T,
    idx: number,
    arr: T[],
  ) => Promise<any>,
  R = AsyncReturnType<F>
>(arr: T[], fn: F): Promise<R[]> {
  return arr.reduce(async (promise, ...args): Promise<R[]> => {
    const accum = await promise;
    const result = await fn(...args);
    return accum.concat(result);
  }, Promise.resolve([] as R[]));
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

export async function loadJson<T = JsonValue>(file: URL): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export function relativeUrl(from: URL, to: URL): string {
  return relative(fileURLToPath(from), fileURLToPath(to));
}
