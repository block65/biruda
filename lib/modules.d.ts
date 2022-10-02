declare module 'npm-packlist' {
  export default function packlist(tree: unknown): Promise<string[]>;
}

declare module '@npmcli/arborist' {
  export default class Arborist {
    constructor({ path: string });
    public loadActual(): Promise<unknown>;

    // note that loading this way should only be done if there's no
    // node_modules folder
    public loadVirtual(): Promise<unknown>;
  }
}

declare module 'trace-deps' {
  export const traceFiles: (options: {
    srcPaths: string[];
    allowMissing?: Record<string, string[]>;
  }) => Promise<{
    dependencies: string[];
    sourceMaps: string[];
    misses: Record<string, { src: string; start; end }[]>;
  }>;
}
