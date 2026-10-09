describe("stable-diffusion noise schedule", () => {
  // β: 0.00085 → 0.012, 1000 train steps, "scaled_linear" (SD 1.x defaults)
  const cfg = { beta_start: 0.00085, beta_end: 0.012, num_train_timesteps: 1000, beta_schedule: "scaled_linear" };
  const all = betaSigmas(cfg);

  it("reproduces the diffusers sigma table", () => {
    expect(all).toHaveLength(1001);
    expect(all[0]).toBeCloseTo(0.00085, 8); // t = 0 (least noisy)
    expect(all[999]).toBeCloseTo(0.2302643413, 6); // t = 999 (noisiest)
    expect(all[950]).toBeCloseTo(0.2143401320, 6);
    expect(all[1000]).toBe(0);
  });

  it("picks 'leading' timesteps like diffusers (T // steps apart, noisiest first)", () => {
    const { sigmas, alphas } = sigmaSchedule(all, 20);
    const expected = [0.2143401320, 0.1985547403, 0.1832362441, 0.1683846492];
    expected.forEach((v, i) => expect(sigmas[i]).toBeCloseTo(v, 7));
    expect(sigmas[19]).toBeCloseTo(0.00085, 8);
    expect(sigmas[20]).toBe(0); // the last "step" lands on the image
    expect(alphas[0]).toBeCloseTo(0.9777915, 6); // 1/√(σ²+1)
    expect(Array.from(sigmas).every((s, i) => i === 0 || s <= sigmas[i - 1])).toBe(true);
  });

  it("can spend the steps the Karras way", () => {
    const { sigmas, alphas } = sigmaSchedule(all, 20, true);
    const expected = [0.2143401320, 0.1747573481, 0.1416130804, 0.1140098126];
    expected.forEach((v, i) => expect(sigmas[i]).toBeCloseTo(v, 7));
    expect(sigmas[19]).toBeCloseTo(0.00085, 8);
    expect(sigmas[20]).toBe(0);
    expect(alphas[2]).toBeCloseTo(0.9901207, 6);
  });

  it("turns latents into σ-space and epsilon into a data estimate", () => {
    const z = Float32Array.of(2, 4);
    const out = new Float32Array(2);
    toSigmaSpace(z, 0.5, out); // x = z/√ᾱ
    expect(Array.from(out)).toEqual([4, 8]);
    dataFromEps(Float32Array.of(1, 1), Float32Array.of(0.5, -0.5), 2, out);
    expect(Array.from(out)).toEqual([0, 2]); // D = x − σ·ε
    dataFromVelocity(Float32Array.of(1, 1), Float32Array.of(0.5, -0.5), 2, out);
    expect(Array.from(out)).toEqual([2, 0]); // D = z + σ·v
  });

  it("solves a constant data estimate exactly in σ-space too", () => {
    const sigmas = Float32Array.of(4, 2, 1, 0);
    const st = makeIntegratorState(1);
    let x = Float32Array.of(0);
    const data = Float32Array.of(3.5);
    for (let i = 0; i < 3; i++) {
      const next = new Float32Array(1);
      integrateDpmpp2m(st, x, data, sigmas[i], sigmas[i + 1], next);
      x = next;
    }
    expect(x[0]).toBeCloseTo(3.5, 5);
  });
});


import { describe, expect, it } from "vitest";
import {
  betaSigmas, dataFromEps, dataFromVelocity, eulerStep, gaussian, guideVelocity, halfToFloat, integrateDpmpp2m,
  integrateEuler, integrateHeun, latentPreview, makeIntegratorState, meanStd, mulberry32, pixelsToRgba, predictX0,
  promptSeed, rescaleGuidance, sigmaSchedule, toFloat32, toSigmaSpace, type Solver,
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

  it("skips the unconditional branch when there is no guidance", () => {
    const vc = Float32Array.of(5, -1);
    const out = new Float32Array(2);
    guideVelocity(vc, null, 3, out);
    expect(Array.from(out)).toEqual([5, -1]);
    guideVelocity(vc, null, 7, out); // cfg is irrelevant without a second branch
    expect(Array.from(out)).toEqual([5, -1]);
  });

  it("rescale pulls the guided velocity towards the conditional scale", () => {
    const vc = Float32Array.of(1, -1, 1, -1);
    const v = Float32Array.of(4, -4, 4, -4);
    const soft = Float32Array.from(v);
    rescaleGuidance(vc, soft, 0.5);
    expect(Math.abs(soft[0])).toBeGreaterThan(1);
    expect(Math.abs(soft[0])).toBeLessThan(4);
    expect(soft[0]).toBeCloseTo(-soft[1]);
    rescaleGuidance(vc, v, 1);
    expect(Math.abs(v[0])).toBeCloseTo(1, 5); // matches the conditional magnitude
    expect(meanStd(Float32Array.of(2, 4)).sd).toBeCloseTo(1);
    const untouched = Float32Array.of(2, 2);
    rescaleGuidance(vc, untouched, 0);
    expect(Array.from(untouched)).toEqual([2, 2]);
  });
});

/* -------------------------------------------------------------------- *
 *  Solvers — checked against ODEs with a known closed-form solution.     *
 * -------------------------------------------------------------------- */

/** Integrates dz/dt = velocity(z, t) from t = 0 to t = tEnd with `steps` steps. */
function solve(
  solver: Solver,
  velocity: (z: Float32Array, t: number, out: Float32Array) => void,
  z0: number,
  steps: number,
  tEnd = 1,
): number {
  let z = Float32Array.of(z0);
  const st = makeIntegratorState(1);
  const v = new Float32Array(1);
  const scratch = new Float32Array(1);
  const next = new Float32Array(1);
  const data = new Float32Array(1);
  const dt = tEnd / steps;
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    velocity(z, t, v);
    if (solver === "dpmpp2m") {
      dataFromVelocity(z, v, 1 - t, data);
      integrateDpmpp2m(st, z, data, 1 - t, 1 - (t + dt), next);
    } else if (solver === "euler") {
      integrateEuler(z, v, dt, next);
    } else {
      integrateEuler(z, v, dt, scratch);
      if (i < steps - 1) {
        velocity(scratch, t + dt, scratch);
        integrateHeun(z, v, scratch, dt, next);
      } else {
        next.set(scratch); // no corrector on the last step: t = 1 is already the data
      }
    }
    z = next.slice();
  }
  return z[0];
}

const constVel = (c: number) => (z: Float32Array, t: number, out: Float32Array) => { out[0] = c; void z; void t; };
const constData = (target: number) => (z: Float32Array, t: number, out: Float32Array) => { out[0] = (target - z[0]) / (1 - t); };
/** dz/dt = −z → z(1) = z0/e */
const decay = (z: Float32Array, t: number, out: Float32Array) => { out[0] = -z[0]; void t; };

describe("solvers", () => {
  it("all three are exact for a constant velocity field", () => {
    for (const s of ["euler", "dpmpp2m", "heun"] as Solver[]) {
      expect(solve(s, constVel(2), 0.5, 25)).toBeCloseTo(2.5, 5);
    }
  });

  it("dpmpp2m is exact when the model predicts the same data at every step", () => {
    // v = (target − z)/σ ⇒ the data estimate D = z + σ·v equals `target` everywhere,
    // which is exactly the case the exponential integrator solves in closed form.
    for (const steps of [4, 8, 20]) {
      expect(solve("dpmpp2m", constData(3.75), 0.5, steps)).toBeCloseTo(3.75, 5);
    }
  });

  it("dpmpp2m's first step is identical to euler's", () => {
    // In flow terms: σ = 1 − t, and the first exponential update reduces to z + dt·v.
    const st = makeIntegratorState(1);
    const z = Float32Array.of(0.3);
    const v = Float32Array.of(-1.2);
    const a = new Float32Array(1), b = new Float32Array(1), data = new Float32Array(1);
    dataFromVelocity(z, v, 1, data);
    integrateDpmpp2m(st, z, data, 1, 0.95, a);
    integrateEuler(z, v, 0.05, b);
    expect(a[0]).toBeCloseTo(b[0], 7);
  });

  it("is second order for dpmpp2m/heun and first order for euler", () => {
    // Stop one step before σ = 0: the "take the data estimate" shortcut used on the
    // final step would otherwise mask the order of the integrators themselves.
    const tEnd = 1 - 1 / 64;
    const err = (s: Solver, n: number) => Math.abs(solve(s, decay, 1, n, tEnd) - Math.exp(-tEnd));
    const ratio = (s: Solver) => err(s, 16) / err(s, 32);
    expect(ratio("euler")).toBeGreaterThan(1.8);
    expect(ratio("euler")).toBeLessThan(2.2);
    for (const s of ["dpmpp2m", "heun"] as Solver[]) {
      expect(ratio(s)).toBeGreaterThan(3.5); // ≈ 2² for a 2nd-order method
    }
  });

  it("beats euler on a real schedule: more accuracy for the same number of network evals", () => {
    const exact = Math.exp(-1);
    const euler32 = Math.abs(solve("euler", decay, 1, 32) - exact);
    const dpm32 = Math.abs(solve("dpmpp2m", decay, 1, 32) - exact);
    const dpm16 = Math.abs(solve("dpmpp2m", decay, 1, 16) - exact);
    expect(dpm32).toBeLessThan(euler32 / 3);
    expect(dpm16).toBeLessThan(euler32);
  });

  it("is deterministic and keeps no state between runs", () => {
    const a = solve("dpmpp2m", decay, 1, 12);
    solve("dpmpp2m", constVel(3), 1, 12); // a different job in between
    expect(solve("dpmpp2m", decay, 1, 12)).toBe(a);
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
