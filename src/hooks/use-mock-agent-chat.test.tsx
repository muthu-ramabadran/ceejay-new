import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMockAgentChat } from "@/hooks/use-mock-agent-chat";

describe("useMockAgentChat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits timeline steps and returns fixed assistant response", async () => {
    const { result } = renderHook(() => useMockAgentChat());

    await act(async () => {
      const pending = result.current.sendMessage("show AI healthcare companies");
      await vi.runAllTimersAsync();
      await pending;
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]?.role).toBe("user");
    expect(result.current.messages[1]?.role).toBe("assistant");
    expect(result.current.messages[1]?.references).toHaveLength(12);
    expect(result.current.activitySteps).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
  });
});
