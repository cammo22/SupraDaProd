import { describe, expect, it } from "vitest";
import {
  eulerStep, gaussian, halfToFloat, latentPreview, mulberry32, pixelsToRgba, predictX0, promptSeed, toFloat32,
} from "../../src/lib/sampler";

describe("rng", () => {
  it("mulberry32 is deterministic and in [0,1)", () => {
    const a = mulberry32(123), b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("gaussian noise is ~N(0,1) and reproducible", () => {
    const g = gaussian(7, 4096);
    expect(gaussian(7, 4096)).toEqual(g);
    const mean = g.reduce((a, v) => a + v, 0) / g.length;
    const varr = g.reduce((a, v) => a + (v - mean) ** 2, 0) / g.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(Math.abs(varr - 1)).toBeLessThan(0.1);
  });

  it("gaussian handles odd lengths", () => {
    expect(gaussian(1, 5)).toHaveLength(5);
  });

  it("promptSeed mixes seed and prompt (and matches the 0.x reference values)", () => {
    expect(promptSeed(0, "")).toBe(7);
    expect(promptSeed(1, "")).toBe(6);
    expect(promptSeed(0, "a")).toBe((7 * 31 + 97) >>> 0);
    expect(promptSeed(5, "cat")).not.toBe(promptSeed(6, "cat"));
    expect(promptSeed(5, "cat")).not.toBe(promptSeed(5, "dog"));
    expect(promptSeed(5, "cat")).toBeGreaterThanOrEqual(0);
  });
});

describe("euler step with CFG", () => {
  it("implements z + dt·(vu + cfg·(vc − vu))", () => {
    const z = Float32Array.of(1, 2), vc = Float32Array.of(4, 0), vu = Float32Array.of(2, 1);
    const out = new Float32Array(2), guided = new Float32Array(2);
    eulerStep(z, vc, vu, 0.1, 3, out, guided);
    expect(guided[0]).toBeCloseTo(2 + 3 * 2);
    expect(guided[1]).toBeCloseTo(1 + 3 * -1);
    expect(out[0]).toBeCloseTo(1 + 0.1 * 8);
    expect(out[1]).toBeCloseTo(2 + 0.1 * -2);
  });

  it("cfg=1 equals the conditional velocity; cfg=0 the unconditional", () => {
    const z = new Float32Array(1), vc = Float32Array.of(5), vu = Float32Array.of(-3);
    const o = new Float32Array(1);
    eulerStep(z, vc, vu, 1, 1, o);
    expect(o[0]).toBe(5);
    eulerStep(z, vc, vu, 1, 0, o);
    expect(o[0]).toBe(-3);
  });

  it("x0 prediction walks the remaining time along the velocity", () => {
    const out = new Float32Array(1);
    predictX0(Float32Array.of(1), Float32Array.of(2), 0.25, out);
    expect(out[0]).toBeCloseTo(1 + 0.75 * 2);
  });

  it("integrating a constant velocity field over N steps reaches z0 + v", () => {
    let z = Float32Array.of(0.5);
    const v = Float32Array.of(2), u = Float32Array.of(2);
    const steps = 25;
    for (let i = 0; i < steps; i++) {
      const n = new Float32Array(1);
      eulerStep(z, v, u, 1 / steps, 3, n);
      z = n;
    }
    expect(z[0]).toBeCloseTo(2.5, 4);
  });
});

describe("numeric helpers", () => {
  it("halfToFloat decodes IEEE half precision", () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7bff)).toBe(65504);
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0xfc00)).toBe(-Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
    expect(halfToFloat(0x0001)).toBeCloseTo(5.96e-8, 9);
    expect(halfToFloat(0x3555)).toBeCloseTo(0.333, 3);
  });

  it("toFloat32 accepts f32, f16 bits and plain arrays", () => {
    const f = Float32Array.of(1.5);
    expect(toFloat32(f)).toBe(f);
    expect(Array.from(toFloat32(Uint16Array.of(0x3c00, 0xc000)))).toEqual([1, -2]);
    expect(Array.from(toFloat32([1, 2, 3] as never))).toEqual([1, 2, 3]);
  });
});

describe("pixels", () => {
  it("maps [-1,1] NCHW floats to RGBA bytes", () => {
    const px = Float32Array.of(-1, 1, /* g */ 0, 0, /* b */ 1, -1);
    const rgba = pixelsToRgba(px, 1 + 0 * 1 === 1 ? 1 : 1);
    // 1x1 image needs 3 floats only
    expect(rgba).toHaveLength(4);
    expect(Array.from(rgba)).toEqual([0, 255, 128, 255]);
  });

  it("clamps out-of-range values", () => {
    const rgba = pixelsToRgba(Float32Array.of(-5, 5, 0), 1);
    expect(Array.from(rgba)).toEqual([0, 255, 128, 255]);
  });

  it("latent preview has one opaque pixel per latent cell", () => {
    const size = 4, ch = 4;
    const z = gaussian(3, ch * size * size);
    const rgba = latentPreview(z, ch, size);
    expect(rgba).toHaveLength(size * size * 4);
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
    // zero latent → mid gray
    const zero = latentPreview(new Float32Array(ch * 16), ch, 4);
    expect(zero[0]).toBe(128);
  });

  it("latent preview also works for non-4-channel latents", () => {
    expect(latentPreview(new Float32Array(3 * 4), 3, 2)).toHaveLength(16);
    expect(latentPreview(new Float32Array(1 * 4), 1, 2)).toHaveLength(16);
  });
});
