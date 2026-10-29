import { TriangleAlertIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";

interface Props {
  children: ReactNode,
  /** Changing this clears the error, e.g. the current path. */
  resetKey?: unknown
}

/** Keeps a crash in one page (or a plugin's component) from blanking the whole editor. */
export class ErrorBoundary extends Component<Props, { error: Error | null, key: unknown }> {
  override state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null, key: unknown }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("vibe-cms: the editor hit an error", error, info.componentStack);
  }

  override render() {
    if(!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <TriangleAlertIcon className="size-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm break-words text-muted-foreground">{this.state.error.message}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="ghost" onClick={() => location.reload()}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }
}
