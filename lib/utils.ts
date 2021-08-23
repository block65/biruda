import findUp from 'find-up';
import fs from 'fs/promises';
import { createRequire } from 'module';
import { isAbsolute, relative, resolve, join, dirname } from 'path';
import pkgDir from 'pkg-dir';
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

  const resolvedModuleEntryPoint = require.resolve(name, {
    paths,
  });

  // native module
  if (resolvedModuleEntryPoint === name) {
    return new URL(`node:${name}`);
  }

  // this helps support monorepos with symlinks
  // where the full module name may not be the same as the module dir
  const packageRhs = name.split('/').at(-1);

  if (!packageRhs) {
    throw new Error(`No package RHS for ${name}`);
  }

  // NOTE: we have to use this technique to find the package root because
  // looking from the resolved entrypoint above for a package.json
  // is unreliable, as there may be a package.json in the module tree
  // even if it is not the root of the actual package
  // tldr: this is intended to be the literal package root, not just some
  // child dir with a package.json in it.
  const pathToModuleRoot = await findUp(
    async (directory) => {
      const parent = join(directory, packageRhs);
      const maybeManifest = join(parent, 'package.json');
      const found = await findUp.exists(maybeManifest);
      logger.trace({ directory, maybeManifest, found });
      return found ? parent : undefined;
    },
    {
      type: 'directory',
      cwd: dirname(resolvedModuleEntryPoint),
      allowSymlinks: true,
    },
  );

  logger.trace(
    { pathToModuleRoot, resolvedModuleEntryPoint },
    'pathToModuleRoot for %s',
    name,
  );

  if (!pathToModuleRoot) {
    throw new Error(`Unable to resolve manifest for ${name}`);
  }

  return pathToFileURL(`${pathToModuleRoot}/`);
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
  ).catch((err: Error | NodeJS.ErrnoException) => {
    // NOTE: it's possible that a package has an erroneous dep
    // which doesnt exist or errors on require (missing exports/main)
    // We have to ignore it here because it may not even be require'd
    // by the parent package at runtime
    if (
      ('code' in err && err.code == 'MODULE_NOT_FOUND') ||
      err.message?.match(/cannot find module/i)
    ) {
      // this check just keeps noise to a minimum
      if (
        // definitelytyped
        !name.startsWith('@types') &&
        // type-fest etc
        !name.startsWith('type-') &&
        // HACK
        !name.startsWith('babel-runtime')
      ) {
        logger.warn(err.message);
      }
      return;
    }
    throw err;
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
