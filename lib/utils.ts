import type { AsyncReturnType } from 'type-fest';

export function serialPromiseMapAccum<
  T,
  F extends (arg: T, idx: number, arr: T[]) => Promise<any> = (
    arg: T,
    idx: number,
    arr: T[],
  ) => Promise<any>,
  R = AsyncReturnType<F>
>(arr: T[], fn: F): Promise<R[]> {
  return arr.reduce(async (promise, ...args): Promise<R[]> => {
    const accum = await promise;
    const result = await fn(...args);
    return accum.concat(result);
  }, Promise.resolve([] as R[]));
}

export function basicThrottle<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
) {
  let callable: boolean = true;
  return (...args: Parameters<T>): void => {
    if (callable) {
      callable = false;
      setTimeout(() => {
        callable = true;
      }, delay);
      callback(...args);
    }
  };
}
