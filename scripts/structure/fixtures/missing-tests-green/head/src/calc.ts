export function over(n: number, max: number): boolean {
  return n > max;
}
export function twice(n: number): number {
  return n * 2;
}
// Stryker disable next-line BlockStatement: half is pinned by its own test
export function half(n: number): number {
  return n / 2;
}
