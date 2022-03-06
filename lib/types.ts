export interface BirudaCliArguments {
  configFile?: string;
  logLevel?: 'trace' | 'debug' | 'info';
  outDir?: string;
  entryPoints?: string[];
  extraModules?: string[];
  extraPaths?: string[];
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  externals?: string[];
  ignorePackages?: string[];
  versionName?: string;
}

export type BirudaOptions = BirudaCliArguments;

export interface BirudaConfigFileProperties
  extends Omit<BirudaCliArguments, 'configFile' | 'entryPoints'> {
  entryPoints?: string[] | Record<string, string>;
}
