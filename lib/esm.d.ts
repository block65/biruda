interface ImportMeta {
  resolve: (specifier: string, parent?: string) => Promise<string>;
}
