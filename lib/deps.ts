import { access, constants, readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import micromatch from 'micromatch';
import pMemoize from 'p-memoize';
import type { PackageJson } from 'type-fest';
import { logger as parentLogger } from './logger.js';

const logger = parentLogger.child({}, { context: { name: 'deps' } });

async function loadPackageJsonInner(
  dirOrFile: string | URL,
  throwOnMissing?: false,
): Promise<[PackageJson | null, URL | null]>;
async function loadPackageJsonInner(
  dirOrFile: string | URL,
  throwOnMissing?: true,
): Promise<[PackageJson, URL]>;
async function loadPackageJsonInner(
  dirOrFile: string | URL,
  throwOnMissing?: boolean,
): Promise<[PackageJson | null, URL | null]> {
  const dirOrFileAsUrl =
    dirOrFile instanceof URL ? dirOrFile : pathToFileURL(dirOrFile);

  const file = dirOrFileAsUrl.pathname.endsWith('package.json')
    ? dirOrFileAsUrl
    : new URL('./package.json', `${dirOrFileAsUrl.toString()}/`);

  const exists = await access(file, constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (throwOnMissing || exists) {
    return [JSON.parse(await readFile(file, 'utf-8')), file];
  }
  return [null, null];
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
    const [manifest] = await loadPackageJson(currentDirectory);

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
