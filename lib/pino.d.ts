import 'pino';

// NOTE: This can be removed when pino-http is compatible with pino 7
declare module 'pino' {
  type LogDescriptor = Record<string, any>;
}
