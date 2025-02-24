import {describe, it, expect} from "vitest";

describe("testing skipped", () => {
  it.skip("sample skipped test", () => {
    expect(true).toBeTruthy();
  })

  it("sample non-skipped test", () => {
    expect(true).toBeTruthy();
  })
})