import { nodeFileTrace, NodeFileTraceReasons } from '@vercel/nft';
import * as fs from 'fs';
import { access, readFile } from 'fs/promises';
import micromatch from 'micromatch';
import pMemoize from 'p-memoize';
import { dirname, normalize, relative } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import * as util from 'util';
import { logger as parentLogger } from './logger.js';
import { loadJson, relativeUrl, resolvePackageJson } from './utils.js';

const logger = parentLogger.child({ name: 'deps' });

export interface RecursiveDependency extends Dependency {
  deps: RecursiveDependency[];
}

export interface Dependency {
  name: string;
  version: string;
  files?: string[];
  path: URL;
}

interface Warning extends Error {
  lineText?: string;
  file?: string;
  line?: number;
  column?: number;
}

async function readManifestInner(
  dirOrFile: string | URL,
  throwOnMissing?: false,
): Promise<PackageJson | null>;
async function readManifestInner(
  dirOrFile: string | URL,
  throwOnMissing?: true,
): Promise<PackageJson>;
async function readManifestInner(
  dirOrFile: string | URL,
  throwOnMissing?: boolean,
): Promise<PackageJson | null> {
  const file = dirOrFile.toString().endsWith('package.json')
    ? dirOrFile
    : new URL('package.json', pathToFileURL(`${dirOrFile.toString()}/`));

  const exists = await access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (throwOnMissing || exists) {
    return JSON.parse(await readFile(file, 'utf-8'));
  }
  return null;
}

export const readManifest = pMemoize(readManifestInner, {
  cacheKey: ([fdirOrFile]) => fdirOrFile,
});

export async function findWorkspaceRoot(initial = process.cwd()) {
  logger.trace('Finding workspace root from %s', initial);

  let previousDirectory = null;
  let currentDirectory = normalize(initial);

  do {
    // suppress eslint here because this needs to be sequential/ serial
    // and cannot be parallelised
    // eslint-disable-next-line no-await-in-loop
    const manifest = await readManifest(currentDirectory);

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

export async function traceDependencies(
  initialDeps: Record<string, string>,
  startPath: URL,
  // mode = 'production',
): Promise<Dependency[]> {
  const circuitBreaker = new Set<string>();

  function recursiveResolveDependencies(
    deps: Record<string, string>,
    base: URL,
  ): Promise<RecursiveDependency[]> {
    return Promise.all(
      Object.entries(deps).map(
        async ([name, version]): Promise<RecursiveDependency> => {
          const modulePackageJsonUrl = await resolvePackageJson(name, base);
          const packageJson = await loadJson<PackageJson>(modulePackageJsonUrl);

          const nextPath = new URL('.', modulePackageJsonUrl);
          const beenHere = circuitBreaker.has(nextPath.toString());

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

          circuitBreaker.add(nextPath.toString());

          const children = await recursiveResolveDependencies(
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
      ),
    );
  }

  return flattenDeps(
    await recursiveResolveDependencies(initialDeps, startPath),
  );
}

export async function traceFiles(
  entryPoints: string[],
  options: {
    baseDir: URL;
    verbose?: boolean;
    ignorePackages?: string[];
  },
): Promise<{
  files: Set<string>;
  base: URL;
  reasons: NodeFileTraceReasons;
}> {
  const { baseDir } = options;

  const maybeWorkspaceRoot = await findWorkspaceRoot(fileURLToPath(baseDir));
  const workspaceRoot = maybeWorkspaceRoot
    ? pathToFileURL(maybeWorkspaceRoot)
    : baseDir;
  // const processCwd = dirname(manifestFilename);

  logger.info(
    entryPoints,
    'Tracing dependencies using base: %s, workspace: %s',
    relativeUrl(workspaceRoot, baseDir),
    workspaceRoot,
  );

  const traceResult = await nodeFileTrace(
    entryPoints.map((entry) => fileURLToPath(new URL(entry, baseDir))),
    {
      base: fileURLToPath(workspaceRoot),
      processCwd: fileURLToPath(baseDir),
      log: options.verbose,
      ignore: options.ignorePackages?.map((pkg) => `node_modules/${pkg}/**`),
      // paths: [base],
      exportsOnly: true,
    },
  );

  const { fileList, esmFileList, reasons } = traceResult;

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
      [...fileList, ...esmFileList].filter(
        (file) => !resolvedEntryPoints.includes(file),
      ),
    ),
  };
}
