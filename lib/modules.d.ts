declare module 'npm-packlist' {
  export default function packlist(tree: unknown): Promise<string[]>;
}
declare module '@npmcli/arborist' {
  export default class Arborist {
    constructor({ path: string });
    public loadActual(): Promise<unknown>;
  }
}
