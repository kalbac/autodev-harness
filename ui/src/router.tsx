import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { HomeView } from "./views/HomeView";
import { RunView } from "./views/RunView";
import { TaskDetailView } from "./views/TaskDetailView";
import { BoardView } from "./views/BoardView";
import { NewProjectView } from "./views/NewProjectView";
import { GlobalSettingsView } from "./views/GlobalSettingsView";
import { ProjectSettingsView } from "./views/ProjectSettingsView";
import { api } from "./lib/api";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const { projects } = await api.getProjects();
    if (projects.length === 0) throw redirect({ to: "/new" });
    throw redirect({ to: "/p/$projectId", params: { projectId: projects[0]!.id } });
  },
});

// /new route: the New Project screen (folder browser + register form). Kept
// inside AppShell so the sidebar stays; the rail predicate excludes non-`/p/`
// paths, so the rail does not render here.
const newProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  component: () => (
    <AppShell>
      <NewProjectView />
    </AppShell>
  ),
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

// Daemon-global settings screen. Root child like /new (owns the full main region).
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <AppShell>
      <GlobalSettingsView />
    </AppShell>
  ),
});

const projectHomeRoute = createRoute({ getParentRoute: () => projectRoute, path: "/", component: HomeView });
const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  component: ProjectSettingsView,
});
const runRoute = createRoute({ getParentRoute: () => projectRoute, path: "/runs/$runId", component: RunView });
const taskRoute = createRoute({ getParentRoute: () => projectRoute, path: "/tasks/$taskId", component: TaskDetailView });
const boardRoute = createRoute({ getParentRoute: () => projectRoute, path: "/board", component: BoardView });

const routeTree = rootRoute.addChildren([
  indexRoute,
  newProjectRoute,
  settingsRoute,
  projectRoute.addChildren([
    projectHomeRoute,
    projectSettingsRoute,
    runRoute,
    taskRoute,
    boardRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
