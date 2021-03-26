// all optional because they might be on command like
export interface BirudaConfigFileProperties {
  entryPoints?: Record<string, string>;
  verbose?: boolean;
  outDir?: string;
  platform?: string;
  externals?: string[];
  forceInclude?: string[];
  ignorePackages?: string[];
  archiveFormat?: 'zip' | 'tar';
  sourceMapSupport?: boolean;
}

export interface BirudaCliArguments {
  config?: string;
  verbose?: boolean;
  output?: string;
  // baseDir?: string;
  entrypoint?: string[];
  archiveFormat?: string;
  forceInclude?: string[];
  sourceMapSupport?: boolean;
}

export interface BirudaBuildOptions {
  verbose?: boolean;
  outDir: string;
  entryPoints: Record<string, string>;
  // baseDir: string;
  platform: string;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
  forceInclude?: string[];
  sourceMapSupport?: boolean;
}
