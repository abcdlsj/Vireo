import { Component, type ReactNode } from "react";

const RELOADED = "vireo.reloaded-for-update";

/**
 * A file of the app that failed to load: after a deploy, a tab opened before
 * it asks for a page's file by its old name, which is gone.
 */
function staleFile(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically/i.test(m);
}

/** Loads the new version once; a second failure in a short while shows the error instead of looping. */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/**
 * Something that broke while drawing a part of the app shows here, with a way
 * back, instead of taking the whole app down to a blank page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; full?: boolean }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    if (staleFile(error)) reloadForUpdate();
  }

  render() {
    if (this.state.error == null) return this.props.children;
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <div className={this.props.full ? "login" : "page"} role="alert" data-testid="error-boundary">
        <div className={this.props.full ? "login-card" : "page-body"}>
          <h3>Something went wrong here</h3>
          <p className="muted small">{message}</p>
          <div className="row-buttons">
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
            {this.props.full ? null : (
              <a className="btn" href="#" onClick={() => this.setState({ error: null })}>
                Go home
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }
}
