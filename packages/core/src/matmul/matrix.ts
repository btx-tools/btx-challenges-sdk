/**
 * Dense matrix over M31 with row-major layout.
 *
 * Lightweight equivalent of `btxd v0.29.7 src/matmul/matrix.{h,cpp}`. We expose
 * only the operations the solver needs: construction, element access, add,
 * and multiplication. Block views live in `transcript.ts`.
 */

import { add as fieldAdd, dot as fieldDot, fromOracle, type Element } from './field.js';

export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  /** Row-major: data[row * cols + col]. Length = rows * cols. */
  readonly data: Uint32Array;
}

/** Construct a zero-initialized matrix. */
export function zeros(rows: number, cols: number): Matrix {
  return { rows, cols, data: new Uint32Array(rows * cols) };
}

/** Element accessor. */
export function get(m: Matrix, row: number, col: number): Element {
  return m.data[row * m.cols + col]!;
}

/** Element setter. */
export function set(m: Matrix, row: number, col: number, value: Element): void {
  m.data[row * m.cols + col] = value;
}

/**
 * Build a `rows × cols` matrix where entry (row, col) is
 * `field.fromOracle(seed, row * cols + col)`.
 *
 * Mirrors `FromSeedRect` in `btxd src/matmul/noise.cpp`.
 */
export function fromSeedRect(seed: Uint8Array, rows: number, cols: number): Matrix {
  const m = zeros(rows, cols);
  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    m.data[i] = fromOracle(seed, i);
  }
  return m;
}

/**
 * Element-wise modular sum `out = a + b` in M31.
 * Throws if dimensions mismatch.
 */
export function matAdd(a: Matrix, b: Matrix): Matrix {
  if (a.rows !== b.rows || a.cols !== b.cols) {
    throw new Error(`matAdd: dim mismatch a=${a.rows}x${a.cols} b=${b.rows}x${b.cols}`);
  }
  const out = zeros(a.rows, a.cols);
  for (let i = 0; i < a.data.length; i++) {
    out.data[i] = fieldAdd(a.data[i]!, b.data[i]!);
  }
  return out;
}

/**
 * Canonical M31 matrix multiplication: `out = a · b`.
 *
 * `a` is rows_a × inner, `b` is inner × cols_b; `out` is rows_a × cols_b.
 * Uses `field.dot` per inner row × col pair, which folds Mersenne every
 * 4 accumulated products.
 */
export function matMul(a: Matrix, b: Matrix): Matrix {
  if (a.cols !== b.rows) {
    throw new Error(`matMul: inner-dim mismatch a.cols=${a.cols} b.rows=${b.rows}`);
  }
  const out = zeros(a.rows, b.cols);
  const rowBuf = new Uint32Array(a.cols);
  const colBuf = new Uint32Array(a.cols);
  for (let i = 0; i < a.rows; i++) {
    for (let k = 0; k < a.cols; k++) rowBuf[k] = a.data[i * a.cols + k]!;
    for (let j = 0; j < b.cols; j++) {
      for (let k = 0; k < a.cols; k++) colBuf[k] = b.data[k * b.cols + j]!;
      out.data[i * b.cols + j] = fieldDot(rowBuf, colBuf, a.cols);
    }
  }
  return out;
}
