import { routes, type RouteInput, type RouteName, type RouteOutput } from "./contract.ts";

export interface LabellerClientOptions {
  url: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export function createLabellerClient(opts: LabellerClientOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.url.replace(/\/$/, "");

  async function call<K extends RouteName>(
    name: K,
    input: RouteInput<K>,
  ): Promise<RouteOutput<K>> {
    const route = routes[name];
    const res = await fetchFn(`${base}${route.path}`, {
      method: route.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`labeller ${name} failed: ${res.status} ${body}`);
    }
    const json = await res.json();
    return route.output.parse(json) as RouteOutput<K>;
  }

  return {
    createLabels: (input: RouteInput<"createLabels">) => call("createLabels", input),
    queryLabels: (input: RouteInput<"queryLabels">) => call("queryLabels", input),
    upsertLabel: (input: RouteInput<"upsertLabel">) => call("upsertLabel", input),
  };
}

export type LabellerClient = ReturnType<typeof createLabellerClient>;
