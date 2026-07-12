import { ThreadView } from "./ThreadView";

/**
 * The project home (`/p/:projectId`) is now the thread main screen: it hosts
 * `ThreadView`, which streams the newest thread or shows the fresh-thread hero.
 * (Runs remain reachable via the sidebar / thread `run_link` cells / RunView
 * routes — the old composer-first hero + "Recent runs" list were replaced by the
 * transcript-forward main screen.)
 */
export function HomeView() {
  return <ThreadView />;
}
