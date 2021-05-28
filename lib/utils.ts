import fs from 'fs/promises';
import { createRequire } from 'module';
import { isAbsolute, relative, resolve } from 'path';
import pkgDir from 'pkg-dir';
import pkgUp from 'pkg-up';
import type { AsyncReturnType, JsonValue, PackageJson } from 'type-fest';
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
export async function resolveModuleRoot(
  name: string,
  base: URL,
  workspaceRoot: URL,
  from?: string,
): Promise<URL> {
  const require = createRequire(base);

  const initialPaths = [fileURLToPath(base), fileURLToPath(workspaceRoot)];

  const resolvedFrom =
    from &&
    require.resolve(from, {
      paths: initialPaths,
    });
  const fromPkgDir = resolvedFrom && (await pkgDir(resolvedFrom));

  const paths = Array.from(
    new Set<string>([
      ...(fromPkgDir ? [fromPkgDir] : []),
      ...initialPaths,
      // ...(require.resolve.paths(name) || []),
    ]),
  );

  const resolved = require.resolve(name, {
    paths,
  });

  // native module
  if (resolved === name) {
    return new URL(`node:${name}`);
  }

  const path = await pkgDir(resolved);

  if (!path) {
    throw new Error(`Unable to resolve manifest for ${name}`);
  }

  return pathToFileURL(`${path}/`);
}

export function serialPromiseMapAccum<
  T,
  F extends (arg: T, idx: number, arr: T[]) => Promise<any> = (
    arg: T,
    idx: number,
    arr: T[],
  ) => Promise<any>,
  R = AsyncReturnType<F>,
>(arr: T[], fn: F): Promise<R[]> {
  return arr.reduce(async (promise, ...args): Promise<R[]> => {
    const accum = await promise;
    const result = await fn(...args);
    return accum.concat(result);
  }, Promise.resolve([] as R[]));
}

export async function getDependencyPathsFromModule(
  name: string,
  base: URL,
  workspaceRoot: URL,
  descendCallback: (path: URL, name: string) => boolean,
  includeCallback: (path: URL, name: string) => void,
  parents: string[] = [],
): Promise<void> {
  const logPrefixString = [...parents, name].join('->');

  logger.debug(
    { parents },
    '[%s] Resolving module root for %s',
    logPrefixString,
    name,
  );

  const moduleRoot = await resolveModuleRoot(
    name,
    base,
    workspaceRoot,
    parents[parents.length - 1],
  ).catch((err) => {
    if (
      err.code === 'MODULE_NOT_FOUND' &&
      !name.startsWith('@types') && // definitelytyped
      !name.startsWith('type-') && // type-fest etc
      !name.startsWith('babel-runtime') // HACK
    ) {
      throw err;
    }
    logger.warn(err.message);
  });

  if (!moduleRoot) {
    return;
  }

  // native module, skip
  if (moduleRoot.protocol === 'node:') {
    return;
  }

  if (!descendCallback(moduleRoot, name)) {
    return;
  }

  logger.trace('[%s] resolved module to %s', logPrefixString, moduleRoot);

  const pkgJson = await readManifest(moduleRoot);

  if (!pkgJson) {
    throw new Error(`Unable to locate manifest for ${name}`);
  }

  includeCallback(new URL('package.json', moduleRoot), name);

  dedupeArray(pkgJson.files || []).forEach((glob) => {
    includeCallback(new URL(glob, moduleRoot), name);
  });

  if (pkgJson.main) {
    includeCallback(new URL(pkgJson.main, moduleRoot), name);
  }

  if (!pkgJson.files) {
    logger.trace('[%s] No files[] in  manifest, adding all', logPrefixString);
    includeCallback(moduleRoot, name);
  }

  const dependencies = Object.keys(pkgJson.dependencies || {});

  // at leaf node
  if (dependencies.length === 0) {
    // callback(modulePath);
    return; // [modulePath];
  }

  logger.trace(
    '[%s] %d deps are listed in manifest, recursing',
    logPrefixString,
    Object.keys(dependencies).length,
  );

  await serialPromiseMapAccum(dependencies, async (pkgDep) => {
    // logger.trace('[%s] Found dep %s', pkgDep, name);
    return getDependencyPathsFromModule(
      pkgDep,
      moduleRoot,
      workspaceRoot,
      descendCallback,
      includeCallback,
      [...parents, name],
    );
  });
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

export async function loadPackageJson(file: URL): Promise<PackageJson> {
  return loadJson<PackageJson>(file);
}

export function relativeUrl(from: URL, to: URL): string {
  return relative(fileURLToPath(from), fileURLToPath(to));
}
