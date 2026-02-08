import { describe, expect, it } from "vitest";

import { FIXED_ASSISTANT_RESULT } from "@/lib/mock/responses";

describe("FIXED_ASSISTANT_RESULT", () => {
  it("always returns 12 references", () => {
    expect(FIXED_ASSISTANT_RESULT.references).toHaveLength(12);
  });
});
