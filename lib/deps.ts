/* eslint-disable global-require,import/no-dynamic-require */
import { dirname, join, normalize, relative } from 'path';
import { nodeFileTrace } from '@vercel/nft';
import pkgUp from 'pkg-up';
import { existsSync, readFileSync } from 'fs';
import type { PackageJson } from 'type-fest';
import micromatch from 'micromatch';
import mem from 'mem';
import { inspect } from 'util';
import { logger } from './logger';

// import readPkgUp from 'read-pkg-up';
// interface Child {
//   name: string;
//   children: Child[];
//   hint: null;
//   color: 'bold';
//   depth: 0;
// }

export interface RecursiveDependency extends Dependency {
  deps: RecursiveDependency[];
}

export interface Dependency {
  name: string;
  version: string;
  files?: string[];
  path: string;
}

// interface YarnListOutput {
//   data: {
//     trees: Child[];
//   };
// }

// export interface Dependency {
//   path: string;
//   version: string;
//   files?: string[];
// }

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

const readManifestSync = mem(readManifestSyncInner, {
  cacheKey: ([fdirOrFile]) => fdirOrFile,
});

function findWorkspaceRoot(initial = process.cwd()) {
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
          'Found  workspaces in %s',
          currentDirectory,
        );

        const relativePath = relative(currentDirectory, initial);
        if (
          relativePath === '' ||
          micromatch([relativePath], workspaces, { bash: true }).length > 0
        ) {
          logger.trace(
            { list: [relativePath], patterns: workspaces },
            'Success! %s',
            currentDirectory,
          );

          return currentDirectory;
        }

        logger.trace(
          { list: [relativePath], patterns: workspaces },
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

// function getPackageDep(id: string, version: string): Dependency {
//   const sourceMapSupportManifestPath = require.resolve(`${id}/package.json`);
//   const sourceMapSupportManifest: PackageJson.PackageJsonStandard = require(sourceMapSupportManifestPath);
//   const sourceMapSupportBase = dirname(sourceMapSupportManifestPath);
//   return {
//     basePath: sourceMapSupportBase,
//     version,
//     files: sourceMapSupportManifest.files || ['**/*'],
//   };
// }

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
        // console.log({ basePath, cwd, name, version });

        // const modulePackageJsonPath = require.resolve(`${name}/package.json`, {
        //   paths: [basePath],
        // });

        // const modulePackageJsonPath = pkgUp.sync({
        //   cwd: dirname(
        //     require.resolve(name, {
        //       paths: [basePath],
        //     }),
        //   ),
        // });

        const modulePackageJsonPath = resolvePackageJson(name, basePath);

        if (!modulePackageJsonPath) {
          throw Object.assign(
            new Error(`Unable to resolve package.json for module ${name}`),
            { modulePackageJsonPath },
          );
        }

        // console.log({ modulePackageJsonPath });

        const packageJson = require(modulePackageJsonPath);

        // if (packageJson.dependencies) {
        //   console.log(
        //     'Will recurse from %s with base %s',
        //     packageJson.name,
        //     dirname(modulePackageJsonPath),
        //   );
        // }

        const nextPath = dirname(modulePackageJsonPath);
        const beenHere = circuitBreaker.has(nextPath);

        // console.log({ nextPath, beenHere });

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

  // console.log(
  //   inspect(resolvePaths(parsedOutput.data.trees, cwd), {
  //     depth: Infinity,
  //     colors: true,
  //   }),
  // );

  return flattenDeps(recursiveResolveDependencies(initialDeps, startPath));
}

// async function collectDeps(
//   cwd: string,
//   selfPackageName: string,
//   mode = 'production',
// ): Promise<ResolvedChild[]> {
//   const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
//
//   const yarnListProcess = spawnSync(
//     command,
//     ['list', `--depth=${0}`, '--json'],
//     {
//       cwd,
//       env: {
//         ...process.env,
//         NODE_ENV: mode,
//       },
//     },
//   );
//
//   if (yarnListProcess.error) {
//     logger.warn(yarnListProcess.error);
//     throw yarnListProcess.error;
//   }
//
//   // console.log(processOutput);
//
//   const parsedOutput: YarnListOutput = JSON.parse(
//     yarnListProcess.stdout.toString(),
//   );
//
//   // console.log({ length: parsedOutput.data.trees.length });
//
//   const isIgnored = (child: Child) => {
//     const [, name, version] = child.name.split(/(.*)@(.*$)/);
//
//     return (
//       name.startsWith('@types') ||
//       name === 'type-fest' ||
//       name === 'fsevents' ||
//       name === selfPackageName
//     );
//   };
//
//   function resolvePaths(children: Child[], path: string): ResolvedChild[] {
//     return children
//       .filter((child) => !isIgnored(child))
//       .map(
//         (child): ResolvedChild => {
//           const [, name, version] = child.name.split(/(.*)@(.*$)/);
//
//           // console.log({ path, name, version, child });
//
//           return {
//             name,
//             version,
//             path: require.resolve(`${name}`, {
//               paths: [path, cwd],
//             }),
//             children: resolvePaths(
//               child.children,
//               resolve(path, 'node_modules', name),
//             ),
//           };
//         },
//       );
//   }
//
//   // console.log(
//   //   inspect(resolvePaths(parsedOutput.data.trees, cwd), {
//   //     depth: Infinity,
//   //     colors: true,
//   //   }),
//   // );
//
//   return resolvePaths(parsedOutput.data.trees, cwd);
// }

export async function traceFiles(
  entryPoint: string,
  options: {
    originalEntryPoint: string;
    verbose?: boolean;
    ignorePackages?: string[];
  },
): Promise<{ files: string[]; base: string }> {
  const { originalEntryPoint } = options;

  const manifestFilename = await pkgUp({
    cwd: dirname(originalEntryPoint),
  });

  if (!manifestFilename) {
    throw new Error('Unreadable manifest');
  }

  const base = findWorkspaceRoot(originalEntryPoint) || originalEntryPoint;
  const processCwd = dirname(manifestFilename);

  logger.info('Calculating dependencies...');
  logger.trace(
    'Looking for dependencies entry: %s, base: %s, wd: %s',
    entryPoint,
    base,
    processCwd,
  );

  const traceResult = await nodeFileTrace([entryPoint], {
    base,
    processCwd,
    log: options.verbose,
    ignore: options.ignorePackages,
    // paths: [base],
  });

  const { fileList /* esmFileList, reasons */ } = traceResult;

  if (traceResult.warnings.length > 0) {
    logger.warn('Trace warnings: %d', traceResult.warnings.length);
    traceResult.warnings.forEach((value: Warning) => {
      if (value.lineText) {
        logger.warn(
          { value },
          `Warning: ${value.message.trim()} caused by ${value.lineText} in ${
            value.file
          }:${value.line}:${value.column}`,
        );
      } else {
        logger.warn(`Warning: ${value.message.trim()}`);
      }
    });
  }

  // const relativeManifestName = relative(base, manifestFilename);

  // const files = Object.entries(fileList)
  //   .filter(([reasonPath, reason]) => {
  //     return !reason.ignored && reasonPath !== relativeManifestName;
  //   })
  //   .map(([reasonPath]): string => reasonPath);

  return { base, files: fileList };
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
      // reason.type === 'resolve'
      // reason.type !== 'initial'
      // logger.info({
      //   reasonPath,
      //   reason: JSON.stringify({
      //     type: reason.type,
      //     ignores: reason.ignored,
      //   }),
      // });
      return (
        !reason.ignored &&
        reason.type === 'resolve' &&
        reasonPath !== relativeManifestName
        // reason.parents.length > 0
        // reasonPath.includes('node_modules')
      );
    })
    .forEach(([reasonPath, reason]): void => {
      // logger.info({
      //   reasonPath,
      //   reason: JSON.stringify({
      //     type: reason.type,
      //     ignores: reason.ignored,
      //     // parents: reason.parents,
      //   }),
      // });

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

        // logger.trace({
        //   version,
        //   files,
        //   main,
        //   browser,
        //   module,
        // });

        return [
          `${manifest.name}@${manifest.version}`,
          {
            name: manifest.name,
            path: basePath,
            version: manifest.version,
            files: manifest.files,
            // files: Array.from(
            //   new Set(manifest.files || []),
            //   // new Set([
            //   //   ...(manifest.main ? [manifest.main] : []),
            //   //   ...(manifest.files || []),
            //   //   /* browser, module, */
            //   // ]),
            // ).filter(Boolean),
          },
        ];
      })
      .sort(([aName], [bName]) => aName.localeCompare(bName)),
  );

  // console.log(dependencies);
  logger.debug('%s dependencies traced.', dependencies.size);

  return dependencies;
}
