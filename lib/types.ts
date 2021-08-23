// all optional because they might be on command like
import { URL } from 'url';

export interface BirudaCliArguments {
  config?: string;
  verbose?: boolean;
  outDir?: string;
  // baseDir?: string;
  entryPoints?: string[];
  archiveFormat?: 'zip' | 'tar';
  forceInclude?: string[];
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
  externals?: string[];
  ignorePackages?: string[];
}

export interface BirudaBuildOptions {
  verbose?: boolean;
  outDir: string;
  entryPoints: Record<string, string>;
  workingDirectory: URL;
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  platform: string;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
  forceInclude?: string[];
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
  archiveFormat?: 'zip' | 'tar';
}
