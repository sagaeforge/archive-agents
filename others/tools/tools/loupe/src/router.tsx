import { createHashHistory, createRootRoute, createRoute, createRouter, retainSearchParams } from '@tanstack/react-router';
import { AppShell } from './app/AppShell.tsx';
import { IdParamError, parseKbId } from './ids.ts';
import { NodeScreen } from './entity/NodeScreen.tsx';
import { validateNodeSearch, validateSourceSearch } from './routes/search.ts';
import { ErrorPage, NotFoundScreen, RouteError } from './screens/ErrorScreens.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { StatusScreen } from './screens/StatusScreen.tsx';
import { SourceScreen } from './source/SourceScreen.tsx';
import { validateTimeSearch, type TimeSearch } from './time/parse.ts';

// The root validates the two time axes once. retainSearchParams keeps them on every Link (design 4).
const rootRoute = createRootRoute({
  validateSearch: validateTimeSearch,
  search: { middlewares: [retainSearchParams<TimeSearch>(['as_of_valid', 'as_of_observed'])] },
  component: AppShell,
  errorComponent: RouteError,
  notFoundComponent: NotFoundScreen,
});

// Ids are untrusted input from deep links: they are checked before anything can reach the KB (design 7.1).
const idParams = {
  parse: ({ id }: { id: string }) => {
    const r = parseKbId(id);
    if (!r.ok) throw new IdParamError(r.reason);
    return { id: r.id };
  },
  // The router encodes the value itself; encoding here too would double it.
  stringify: ({ id }: { id: string }) => ({ id }),
};

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomeScreen });
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: '/status', component: StatusScreen });
const nodeRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/node/$id', params: idParams, validateSearch: validateNodeSearch, component: NodeScreen, errorComponent: RouteError,
});
const sourceRoute = createRoute({
  getParentRoute: () => rootRoute, path: '/source/$id', params: idParams, validateSearch: validateSourceSearch, component: SourceScreen, errorComponent: RouteError,
});

export const routeTree = rootRoute.addChildren([indexRoute, statusRoute, nodeRoute, sourceRoute]);
export const router = createRouter({
  routeTree, history: createHashHistory(), defaultPreload: false, scrollRestoration: true, defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
