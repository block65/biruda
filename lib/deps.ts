import {
  nodeFileTrace,
  NodeFileTraceOptions,
  NodeFileTraceReasons,
} from '@vercel/nft';
import * as fs from 'fs';
import { access, readFile } from 'fs/promises';
import micromatch from 'micromatch';
import pMemoize from 'p-memoize';
import { dirname, relative } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({ name: 'deps' });

interface Warning extends Error {
  lineText?: string;
  file?: string;
  line?: number;
  column?: number;
}

async function loadPackageJsonInner(
  dirOrFile: string | URL,
  throwOnMissing?: false,
): Promise<PackageJson | null>;
async function loadPackageJsonInner(
  dirOrFile: string | URL,
  throwOnMissing?: true,
): Promise<PackageJson>;
async function loadPackageJsonInner(
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

export const loadPackageJson = pMemoize(loadPackageJsonInner, {
  cacheKey: ([fdirOrFile]) => fdirOrFile,
});

export async function findWorkspaceRoot(initial: URL): Promise<URL> {
  const initialAsPath = fileURLToPath(initial);
  logger.trace('Finding workspace root from %s', initialAsPath);

  let previousDirectory = null;
  let currentDirectory = initialAsPath;

  do {
    // suppress eslint here because this needs to be sequential/ serial
    // and cannot be parallelised
    // eslint-disable-next-line no-await-in-loop
    const manifest = await loadPackageJson(currentDirectory);

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

        const relativePath = relative(currentDirectory, initialAsPath);
        if (
          relativePath === '' ||
          micromatch([relativePath], workspaces, { bash: true }).length > 0
        ) {
          logger.trace(
            { patterns: workspaces },
            'Using workspace root at %s',
            currentDirectory,
          );

          return pathToFileURL(`${currentDirectory}/`);
        }

        logger.trace(
          { relativePath, patterns: workspaces },
          'Workspace doesnt include me %s',
          currentDirectory,
        );

        return initial;
      }
      logger.trace('No workspaces in %s', currentDirectory);
    } else {
      logger.trace('No manifest in %s', currentDirectory);
    }

    previousDirectory = currentDirectory;
    currentDirectory = dirname(currentDirectory);
  } while (currentDirectory !== previousDirectory);

  return initial;
}

export async function traceFiles(
  entryPoints: string[],
  options: {
    workspaceRoot?: URL;
    // workingDirectory?: URL;
    ignorePackages?: string[];
    ignorePaths?: string[];
  },
): Promise<{
  files: Set<string>;
  reasons: NodeFileTraceReasons;
}> {
  logger.info('Tracing dependencies...');

  const base = options.workspaceRoot && fileURLToPath(options.workspaceRoot);

  const opts: NodeFileTraceOptions = {
    // needed in monorepo situations, as nft won't include files above this dir
    base,
    // processCwd:
    //   options.workingDirectory && fileURLToPath(options.workingDirectory),
    log: logger.levelVal < 30,
    ignore: [
      'node:*',
      ...(options.ignorePackages || []).map((pkg) => `node_modules/${pkg}/**`),
      ...(options.ignorePaths || []).map((path) => `${path}/**`),
    ],
    exportsOnly: true,
  };

  logger.debug(opts, 'Tracing %d entrypoints...', entryPoints.length);

  const traceResult = await nodeFileTrace(
    entryPoints, // .map((entry) => fileURLToPath(new URL(entry, baseDir))),
    opts,
  );

  const { fileList, esmFileList, reasons } = traceResult;

  logger.info(
    { reasons: [...Object.entries(reasons)], size: reasons.size },
    'Found %d files, %d esmFileList in trace',
    fileList.size,
    esmFileList.size,
  );

  if (traceResult.warnings.size > 0) {
    // logger.warn('Trace warnings: %d', traceResult.warnings.size);
    traceResult.warnings.forEach((value: Warning) => {
      if (value.lineText) {
        logger.warn(
          { value },
          `%s caused by %s in %s:%d:%d`,
          value.message.trim(),
          value.lineText,
          value.file,
          value.line,
          value.column,
        );
      } else if (
        value.message.startsWith('Failed to resolve dependency node:')
      ) {
        // dont warn about node: prefixes
        logger.trace(value.message.trim());
      } else {
        logger.warn(value.message.trim());
      }
    });
  }

  // find and exclude the initial entry points
  const resolvedEntryPoints = Array.from(reasons.entries())
    .filter(([, reason]) => !reason.ignored)
    .filter(([, reason]) => reason.type === 'initial')
    .filter(([, reason]) => reason.type !== 'resolve')
    .map(([file]) => file);

  logger.info('Trace complete.');

  return {
    reasons,
    files: new Set(
      [...fileList, ...esmFileList].filter(
        (file) => !resolvedEntryPoints.includes(file),
      ),
    ),
  };
}
