import { findUp, pathExists } from 'find-up';
import { PathLike } from 'fs';
import fs, { readdir, stat } from 'fs/promises';
import glob from 'glob';
import { createRequire } from 'module';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'path';
import { packageDirectory } from 'pkg-dir';
import type { AsyncReturnType, JsonValue } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { loadPackageJson } from './deps.js';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ name: 'utils' });

export function maybeMakeAbsolute(entry: string, baseDir: string): string {
  if (isAbsolute(entry)) {
    return entry;
  }
  return resolvePath(baseDir, entry);
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
  const fromPkgDir =
    resolvedFrom &&
    (await packageDirectory({
      cwd: resolvedFrom,
    }));

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
      const found = await pathExists(maybeManifest);
      // logger.trace({ directory, maybeManifest, found });
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

/**
 * @deprecated
 * @use for await ... const
 * @param {T[]} arr
 * @param {(arg: T, idx: number, arr: T[]) => Promise<void>} fn
 * @return {Promise<void>}
 */
export function serialPromiseForEach<T>(
  arr: T[],
  fn: (arg: T, idx: number, arr: T[]) => Promise<void>,
): Promise<void> {
  return arr.reduce(
    (promise, ...args) => promise.then(() => fn(...args)),
    Promise.resolve(),
  );
}

export function serialPromiseMap<
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
    return [...accum, result];
  }, Promise.resolve([] as R[]));
}

export function relativeFileUrl(from: URL, to: URL): string {
  return relative(fileURLToPath(from), fileURLToPath(to));
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

  logger.trace(
    // { parents },
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
      ('code' in err && err.code === 'MODULE_NOT_FOUND') ||
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
        logger.warn(err);
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

  const pkgJson = await loadPackageJson(moduleRoot);

  if (!pkgJson) {
    throw new Error(`Unable to locate manifest for ${name}`);
  }

  // const files = Object.keys(pkgJson.files || []);

  if (pkgJson.files) {
    // eslint-disable-next-line no-restricted-syntax
    for await (const fileGlob of pkgJson.files) {
      const pkgFiles = await new Promise<string[]>((resolve, reject) => {
        glob(
          fileGlob,
          {
            cwd: fileURLToPath(moduleRoot),
            ignore: ['**/*.d.ts'], // we force ignoring of types
          },
          (err, files) => {
            if (err) {
              reject(err);
            } else {
              resolve(files);
            }
          },
        );
      });
      pkgFiles.forEach((file) =>
        includeCallback(new URL(file, moduleRoot), name),
      );
    }
  } else {
    includeCallback(moduleRoot, name);
  }

  // Check for symlinked module in a monorepo
  const relPath = relativeFileUrl(workspaceRoot, moduleRoot);
  if (!relPath.startsWith('node_modules')) {
    includeCallback(new URL(`./node_modules/${name}`, workspaceRoot), name);
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

  await serialPromiseMap(dependencies, async (pkgDep) => {
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
    ([met, unmet], elem, idx): [T[], T[]] => {
      return predicate(elem, idx)
        ? [[...met, elem], unmet]
        : [met, [...unmet, elem]];
    },
    [[], []],
  );
}
