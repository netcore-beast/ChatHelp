import { describe, expect, it } from "vitest";
import { normalizedCropToPixels } from "../src/lib/localOcr";

describe("local screen crop", () => {
  it("converts the selected normalized area into source-image pixels", () => {
    expect(normalizedCropToPixels({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, 1920, 1080)).toEqual({
      x: 480,
      y: 108,
      width: 960,
      height: 864,
    });
  });

  it("clamps a selection to the source-image boundary", () => {
    expect(normalizedCropToPixels({ x: 0.9, y: 0.95, width: 0.5, height: 0.5 }, 1000, 800)).toEqual({
      x: 900,
      y: 760,
      width: 100,
      height: 40,
    });
  });
});
