/* eslint-disable global-require,import/no-dynamic-require */
import { dirname, join, normalize, relative, resolve } from 'path';
import { nodeFileTrace, NodeFileTraceReasons } from '@vercel/nft';
import pkgUp from 'pkg-up';
import { existsSync, readFileSync } from 'fs';
import type { PackageJson } from 'type-fest';
import micromatch from 'micromatch';
import mem from 'mem';
import { logger as parentLogger } from './logger';

const logger = parentLogger.child({ name: 'deps' });

export interface RecursiveDependency extends Dependency {
  deps: RecursiveDependency[];
}

export interface Dependency {
  name: string;
  version: string;
  files?: string[];
  path: string;
}

export type DependencyMap = Map<string, Dependency>;

interface Warning extends Error {
  lineText?: string;
  file?: string;
  line?: number;
  column?: number;
}

function readManifestSyncInner(
  dirOrFile: string,
  throwOnMissing?: false,
): PackageJson | null;
function readManifestSyncInner(
  dirOrFile: string,
  throwOnMissing: true,
): PackageJson;
function readManifestSyncInner(
  dirOrFile: string,
  throwOnMissing = false,
): PackageJson | null {
  const file = dirOrFile.endsWith('package.json')
    ? dirOrFile
    : join(dirOrFile, 'package.json');

  if (throwOnMissing || existsSync(file)) {
    return JSON.parse(readFileSync(file).toString());
  }
  return null;
}

export const readManifestSync = mem(readManifestSyncInner, {
  cacheKey: ([fdirOrFile]) => fdirOrFile,
});

export function findWorkspaceRoot(initial = process.cwd()) {
  logger.trace('Finding workspace root from %s', initial);

  let previousDirectory = null;
  let currentDirectory = normalize(initial);

  do {
    const manifest = readManifestSync(currentDirectory);

    if (manifest) {
      const workspaces = Array.isArray(manifest.workspaces)
        ? manifest.workspaces
        : manifest.workspaces?.packages;

      if (workspaces) {
        logger.trace(
          { workspaces },
          'Found workspaces in %s',
          currentDirectory,
        );

        const relativePath = relative(currentDirectory, initial);
        if (
          relativePath === '' ||
          micromatch([relativePath], workspaces, { bash: true }).length > 0
        ) {
          logger.trace(
            { patterns: workspaces },
            'Using workspace root at %s',
            currentDirectory,
          );

          return currentDirectory;
        }

        logger.trace(
          { relativePath, patterns: workspaces },
          'Workspace doesnt include me %s',
          currentDirectory,
        );

        return null;
      }
      logger.trace('No workspaces in %s', currentDirectory);
    } else {
      logger.trace('No manifest in %s', currentDirectory);
    }

    previousDirectory = currentDirectory;
    currentDirectory = dirname(currentDirectory);
  } while (currentDirectory !== previousDirectory);

  return null;
}

function flattenDeps(initialChildren: RecursiveDependency[]): Dependency[] {
  // console.log({ children });
  return initialChildren.flatMap((child): Dependency[] => {
    const { deps, ...childWithoutChildren } = child;
    // console.log({ child, flat: flattenDeps(child.children) });
    return deps.length > 0
      ? [childWithoutChildren, ...flattenDeps(deps)]
      : [childWithoutChildren];
  });
}

function resolvePackageJson(name: string, base: string) {
  try {
    return require.resolve(`${name}/package.json`, {
      paths: [base],
    });
  } catch (err) {
    if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      if (logger.isLevelEnabled('debug')) {
        logger.warn({ base, name }, 'WARN: %s', err.message);
      }

      return pkgUp.sync({
        cwd: dirname(
          require.resolve(name, {
            paths: [base],
          }),
        ),
      });
    }
    throw err;
  }
}

export async function traceDependencies(
  initialDeps: Record<string, string>,
  startPath: string,
  // mode = 'production',
): Promise<Dependency[]> {
  const circuitBreaker = new Set<string>();

  function recursiveResolveDependencies(
    deps: Record<string, string>,
    basePath: string,
  ): RecursiveDependency[] {
    return Object.entries(deps).map(
      ([name, version]): RecursiveDependency => {
        const modulePackageJsonPath = resolvePackageJson(name, basePath);

        if (!modulePackageJsonPath) {
          throw Object.assign(
            new Error(`Unable to resolve package.json for module ${name}`),
            { modulePackageJsonPath },
          );
        }

        const packageJson = require(modulePackageJsonPath);

        const nextPath = dirname(modulePackageJsonPath);
        const beenHere = circuitBreaker.has(nextPath);

        // if we've already been here, we just return empty children as
        // a previous iteration has already returned the children
        if (beenHere) {
          return {
            name,
            version,
            path: nextPath,
            files: packageJson.files,
            deps: [],
          };
        }

        circuitBreaker.add(nextPath);

        const children = recursiveResolveDependencies(
          packageJson.dependencies || {},
          nextPath,
        );

        return {
          name,
          version,
          path: nextPath,
          files: packageJson.files,
          deps: children,
        };
      },
    );
  }

  return flattenDeps(recursiveResolveDependencies(initialDeps, startPath));
}

export async function traceFiles(
  entryPoints: string[],
  options: {
    baseDir: string;
    verbose?: boolean;
    ignorePackages?: string[];
  },
): Promise<{
  files: Set<string>;
  base: string;
  reasons: NodeFileTraceReasons;
}> {
  const { baseDir } = options;

  const workspaceRoot = findWorkspaceRoot(baseDir) || baseDir;
  // const processCwd = dirname(manifestFilename);

  logger.info(
    entryPoints,
    'Tracing dependencies using base: %s, workspace: %s',
    relative(workspaceRoot, baseDir),
    workspaceRoot,
  );

  const traceResult = await nodeFileTrace(
    entryPoints.map((entry) => resolve(baseDir, entry)),
    {
      base: workspaceRoot,
      processCwd: baseDir,
      log: options.verbose,
      ignore: options.ignorePackages?.map((pkg) => `node_modules/${pkg}/**`),
      // paths: [base],
    },
  );

  const { fileList /* esmFileList */, reasons } = traceResult;

  if (traceResult.warnings.length > 0) {
    logger.warn('Trace warnings: %d', traceResult.warnings.length);
    traceResult.warnings.forEach((value: Warning) => {
      if (value.lineText) {
        logger.warn(
          { value },
          `${value.message.trim()} caused by ${value.lineText} in ${
            value.file
          }:${value.line}:${value.column}`,
        );
      } else {
        logger.warn(value.message.trim());
      }
    });
  }

  // find and exclude the initial entry points
  const resolvedEntryPoints = Object.entries(reasons)
    .filter(([, reason]) => reason.type === 'initial')
    .map(([file]) => file);

  return {
    base: workspaceRoot,
    reasons,
    files: new Set(
      fileList.filter((file) => !resolvedEntryPoints.includes(file)),
    ),
  };
}

export async function traceFileDependencies(
  file: string,
  options: {
    workingDirectory: string;
    verbose?: boolean;
    ignorePackages?: string[];
  },
): Promise<DependencyMap> {
  const { workingDirectory } = options;
  const workspaceRoot = findWorkspaceRoot(workingDirectory) || workingDirectory;

  logger.info('Calculating dependencies...');
  logger.trace(
    'Looking for dependencies in %s, using %s as workspaceRoot',
    file,
    workspaceRoot,
  );

  const manifestFilename = pkgUp.sync({
    cwd: dirname(file),
  });

  if (!manifestFilename) {
    throw new Error('Unreadable manifest');
  }

  const traceBase = workspaceRoot;

  const traceResult = await nodeFileTrace([file], {
    base: traceBase,
    processCwd: workingDirectory,
    log: options.verbose,
    ignore: options.ignorePackages,
    // paths: [base],
  });

  const { /* fileList, esmFileList, */ reasons } = traceResult;

  if (traceResult.warnings.length > 0) {
    logger.warn('Trace warnings: %d', traceResult.warnings.length);
    traceResult.warnings.forEach((value: Warning) => {
      logger.warn(
        `Warning: ${value.message} caused by ${value.lineText} in ${value.file}:${value.line}:${value.column}`,
      );
    });
  }

  const packageIdsFromReasons = new Set<{ basePath: string; name: string }>();

  const relativeManifestName = relative(traceBase, manifestFilename);

  Object.entries(reasons)
    .filter(([reasonPath, reason]) => {
      return (
        !reason.ignored &&
        reason.type === 'resolve' &&
        reasonPath !== relativeManifestName
        // reason.parents.length > 0
        // reasonPath.includes('node_modules')
      );
    })
    .forEach(([reasonPath]): void => {
      const absReasonPath = join(workspaceRoot, reasonPath);
      const [basePath, name] =
        absReasonPath.match(
          /.*node_modules\/(@(\w|-)+\/(\w|-|\.)+|(\w|-|\.)+)/,
        ) || [];

      if (name) {
        packageIdsFromReasons.add({ name, basePath });
        return;
      }

      // possibly not in node_modules and therefore a workspace dep
      const packageJsonPath = pkgUp.sync({
        cwd: dirname(absReasonPath),
      });

      if (!packageJsonPath) {
        throw new Error(
          `Unable to resolve package json for from ${absReasonPath}`,
        );
      }

      const manifest = readManifestSync(packageJsonPath);

      if (!manifest || !manifest.name) {
        throw new Error(
          `Unable to read package json or module name from file://${packageJsonPath}`,
        );
      }

      packageIdsFromReasons.add({
        name: manifest.name,
        basePath: dirname(packageJsonPath),
      });
      // return { id: manifest.name, basePath: packageJsonPath };
    });

  const dependencies: DependencyMap = new Map(
    Array.from(packageIdsFromReasons.values())
      .map(({ name, basePath }): [string, Dependency] => {
        // const manifest = require.resolve(id);
        const manifest = readManifestSync(basePath, true);

        if (!manifest.version || !manifest.name) {
          logger.trace({ manifest, basePath });
          throw new Error(`Module ${name} manifest is invalid`);
        }

        return [
          `${manifest.name}@${manifest.version}`,
          {
            name: manifest.name,
            path: basePath,
            version: manifest.version,
            files: manifest.files,
          },
        ];
      })
      .sort(([aName], [bName]) => aName.localeCompare(bName)),
  );

  logger.debug('%s dependencies traced.', dependencies.size);

  return dependencies;
}
