import { dirname } from 'path';
import { traceDependencies, traceFileDependencies } from '../lib/deps';

describe('Deps Fixtures', () => {
  // test('collect', async () => {});
  // test('flatten', async () => {});

  test('traceFileDependencies', async () => {
    const entryPoint = require.resolve('./fixtures');
    // const packageJsonPath = require.resolve('./fixtures/package.json');

    await expect(
      traceFileDependencies(entryPoint, { workingDirectory: __dirname }),
    ).resolves.toMatchSnapshot();
  });

  test('traceDependencies', async () => {
    const base = require.resolve('./fixtures');
    // eslint-disable-next-line global-require
    const manifest = require(`./fixtures/package.json`);

    await expect(
      traceDependencies(manifest.dependencies, dirname(base)).catch((err) => {
        console.error(err);
        throw err;
      }),
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
