interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  return <div className="h-screen w-screen">{children}</div>;
}
