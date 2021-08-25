export interface BirudaCliArguments {
  configFile?: string;
  logLevel?: 'trace' | 'debug' | 'info';
  outDir?: string;
  entryPoints?: string[];
  archiveFormat?: 'zip' | 'tar';
  extraModules?: string[];
  extraPaths?: string[];
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  sourceMapSupport?: boolean;
  compressionLevel?: number;
  externals?: string[];
  ignorePackages?: string[];
}

export interface BirudaConfigFileProperties
  extends Omit<BirudaCliArguments, 'configFile' | 'entryPoints'> {
  entryPoints?: string[] | Record<string, string>;
}
