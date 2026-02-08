import { AlertCircle, Loader2, MessageSquare } from "lucide-react";

interface StateProps {
  title: string;
  description: string;
}

function BaseState({ icon, title, description }: StateProps & { icon: React.JSX.Element }): React.JSX.Element {
  return (
    <div className="flex flex-col py-16 text-center">
      <div className="mx-auto">{icon}</div>
      <h3 className="mt-3 text-base font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm text-[var(--text-secondary)]">{description}</p>
    </div>
  );
}

export function EmptyState({
  title = "Start a company search",
  description = "Ask for startups by domain, niche, or style. The timeline below will show what the agent is doing.",
}: Partial<StateProps>): React.JSX.Element {
  return (
    <BaseState
      icon={<MessageSquare className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />}
      title={title}
      description={description}
    />
  );
}

export function LoadingState({
  title = "Working on your request",
  description = "Planning and compiling results...",
}: Partial<StateProps>): React.JSX.Element {
  return (
    <BaseState
      icon={<Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden="true" />}
      title={title}
      description={description}
    />
  );
}

export function ErrorState({
  title = "Something went wrong",
  description = "Try submitting your request again.",
}: Partial<StateProps>): React.JSX.Element {
  return (
    <BaseState
      icon={<AlertCircle className="h-5 w-5 text-red-400" aria-hidden="true" />}
      title={title}
      description={description}
    />
  );
}
