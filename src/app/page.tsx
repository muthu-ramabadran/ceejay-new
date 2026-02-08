import { ChatShell } from "@/components/chat/chat-shell";

export default function HomePage(): React.JSX.Element {
  return (
    <main className="h-screen bg-background">
      <ChatShell />
    </main>
  );
}
