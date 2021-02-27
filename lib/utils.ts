import type { AsyncReturnType } from 'type-fest';
import { dirname, isAbsolute, join, resolve } from 'path';
import { readManifestSync } from './deps';
import { logger as parentLogger } from './logger';

const logger = parentLogger.child({ name: 'utils' });

export function maybeMakeAbsolute(entry: string, baseDir: string): string {
  if (isAbsolute(entry)) {
    return entry;
  }
  return resolve(baseDir, entry);
}

export function resolveModulePath(id: string, from: string): string {
  logger.trace('Resolving module path for "%s" from %s', id, from);

  return dirname(
    require.resolve(`${id}/package.json`, {
      paths: [from],
    }),
  );
}

export function dedupeArray<T extends any>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function getDependencyPathsFromModule(
  name: string,
  base: string,
  descendCallback: (path: string, name: string) => boolean,
  includeCallback: (path: string, name: string) => void,
  parents: string[] = [],
): void {
  logger.debug('[%s] Resolving deps for "%s"', parents.join('->'), name);
  const modulePath = resolveModulePath(name, base);

  if (!descendCallback(modulePath, name)) {
    return;
  }

  const pkgJson = readManifestSync(modulePath);

  if (!pkgJson) {
    throw new Error(`Unable to locate manifest for ${name}`);
  }

  dedupeArray([
    // 'package.json',
    // 'LICENSE',
    // 'LICENSE.md',
    ...(pkgJson.files ? pkgJson.files : []),
    ...(pkgJson.main ? [pkgJson.main] : []),
  ]).forEach((glob) => {
    includeCallback(join(modulePath, glob), name);
  });

  const dependencies = Object.keys(pkgJson.dependencies || {});

  logger.trace('[%s] Found %d deps', name, Object.keys(dependencies).length);

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
