import { nodeFileTrace, NodeFileTraceReasons } from '@vercel/nft';
import * as fs from 'fs';
import { access, readFile } from 'fs/promises';
import micromatch from 'micromatch';
import pMemoize from 'p-memoize';
import { dirname, normalize, relative } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { logger as parentLogger } from './logger.js';
import { relativeUrl } from './utils.js';

const logger = parentLogger.child({ name: 'deps' });

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
  const dirOrFileAsUrl =
    dirOrFile instanceof URL ? dirOrFile : pathToFileURL(dirOrFile);

  const file = dirOrFileAsUrl.pathname.endsWith('package.json')
    ? dirOrFileAsUrl
    : new URL('./package.json', `${dirOrFileAsUrl.toString()}/`);

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

export async function traceFiles(
  entryPoints: string[],
  options: {
    baseDir: URL;
    verbose?: boolean;
    ignorePackages?: string[];
  },
): Promise<{
  files: Set<string>;
  workspaceRoot: URL;
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
    workspaceRoot,
    reasons,
    files: new Set(
      [...fileList, ...esmFileList].filter(
        (file) => !resolvedEntryPoints.includes(file),
      ),
    ),
  };
}
