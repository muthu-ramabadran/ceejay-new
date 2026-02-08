import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/chat/message-bubble";

describe("MessageBubble", () => {
  it("calls callback when a company reference chip is clicked", async () => {
    const onOpenReference = vi.fn();
    const user = userEvent.setup();

    render(
      <MessageBubble
        onOpenReference={onOpenReference}
        message={{
          id: "1",
          role: "assistant",
          content: "Result",
          createdAt: new Date().toISOString(),
          references: [
            {
              companyId: "sanas-ai",
              companyName: "Sanas",
              reason: "Voice AI fit",
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open details for Sanas" }));

    expect(onOpenReference).toHaveBeenCalledWith("sanas-ai");
  });
});
