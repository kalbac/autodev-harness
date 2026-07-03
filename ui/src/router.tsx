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

// /new route: a placeholder view for now (NewProjectView arrives in M4-6). Render a
// simple AppShell-wrapped placeholder so the redirect target exists and compiles.
const newProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  component: () => (
    <AppShell>
      <div className="grid h-full place-items-center text-muted">New Project — coming in M4-6</div>
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

const projectHomeRoute = createRoute({ getParentRoute: () => projectRoute, path: "/", component: HomeView });
const runRoute = createRoute({ getParentRoute: () => projectRoute, path: "/runs/$runId", component: RunView });
const taskRoute = createRoute({ getParentRoute: () => projectRoute, path: "/tasks/$taskId", component: TaskDetailView });
const boardRoute = createRoute({ getParentRoute: () => projectRoute, path: "/board", component: BoardView });

const routeTree = rootRoute.addChildren([
  indexRoute,
  newProjectRoute,
  projectRoute.addChildren([projectHomeRoute, runRoute, taskRoute, boardRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
