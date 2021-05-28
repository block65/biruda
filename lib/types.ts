// all optional because they might be on command like
export interface BirudaConfigFileProperties {
  entryPoints?: Record<string, string>;
  verbose?: boolean;
  outDir?: string;
  platform?: string;
  externals?: string[];
  forceInclude?: string[];
  sourceType?: 'esm' | 'cjs';
  // forceBuild?: string[];
  ignorePackages?: string[];
  archiveFormat?: 'zip' | 'tar';
  sourceMapSupport?: boolean;
  compressionLevel?: number;
}

export interface BirudaCliArguments {
  config?: string;
  verbose?: boolean;
  output?: string;
  // baseDir?: string;
  entrypoint?: string[];
  archiveFormat?: 'zip' | 'tar';
  forceInclude?: string[];
  sourceType?: 'esm' | 'cjs';
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
}

export interface BirudaBuildOptions {
  verbose?: boolean;
  outDir: string;
  entryPoints: Record<string, string>;
  // baseDir: string;
  sourceType?: 'esm' | 'cjs';
  platform: string;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
  forceInclude?: string[];
  // forceBuild?: string[];
  sourceMapSupport?: boolean;
  compressionLevel?: number;
}
