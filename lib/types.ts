// all optional because they might be on command like
import { URL } from 'url';

export interface BirudaCliArguments {
  config?: string;
  logLevel?: 'trace' | 'debug' | 'info';
  outDir?: string;
  // baseDir?: string;
  entryPoints?: string[];
  archiveFormat?: 'zip' | 'tar';
  extraModules?: string[];
  extraPaths?: string[];
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
  externals?: string[];
  ignorePackages?: string[];
}

export interface BirudaBuildOptions {
  logLevel?: 'trace' | 'debug' | 'info';
  outDir: string;
  entryPoints: Record<string, string>;
  workingDirectory: URL;
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  platform: string;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
  extraModules?: string[];
  extraPaths?: string[];
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
  archiveFormat?: 'zip' | 'tar';
}
