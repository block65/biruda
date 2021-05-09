import { PackageJson } from 'type-fest';
import { URL } from 'url';
import { traceDependencies } from '../lib/deps';
import { loadJson } from '../lib/utils.js';

function logNThrow(err: any) {
  console.error(err);
  throw err;
}

describe('Deps Fixtures', () => {
  // test('collect', async () => {});
  // test('flatten', async () => {});

  // test('traceFileDependencies', async () => {
  //   const entryPoint = require.resolve('./fixtures');
  //   // const packageJsonPath = require.resolve('./fixtures/package.json');
  //
  //   await expect(
  //     traceFileDependencies(entryPoint, { workingDirectory: __dirname }),
  //   ).resolves.toMatchSnapshot();
  // });

  test('traceDependencies', async () => {
    const base = new URL('./fixtures/fixture1/', import.meta.url);

    const manifest = await loadJson<PackageJson>(new URL('package.json', base));

    await expect(
      traceDependencies(manifest.dependencies || {}, base).catch(logNThrow),
    ).resolves.toMatchSnapshot();
  });
});

// describe('Deps API', () => {
//   test('collect', async () => {});
//   test('flatten', async () => {});
//
//   test('traceFileDeps', async () => {
//     const entryPoint = require.resolve(
//       '../../api/dist/src/handlers/grpc/server.js',
//     );
//
//     await expect(
//       traceFileDependencies(entryPoint, { workingDirectory: __dirname }),
//     ).resolves.toMatchSnapshot();
//   });
//
//   test('listDeps', async () => {
//     const base = require.resolve('../../api/package.json');
//     const manifest = require(base);
//
//     await expect(
//       traceDependencies(manifest.dependencies, dirname(base)),
//     ).resolves.toMatchSnapshot();
//   });
// });

// describe('resolve-paths', () => {});
