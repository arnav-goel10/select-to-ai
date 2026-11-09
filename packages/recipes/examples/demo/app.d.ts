/** The small "Draft" app used by the demo and the quickstart. */
export type DemoSite = "original" | "cosmetic" | "decoy" | "publish";

export interface DemoApp {
  /** e.g. "http://127.0.0.1:53123"; the draft page is at `${url}/draft`. */
  url: string;
  /**
   * Switch the site to another version, and reset its state:
   * "original" as recorded; "cosmetic" ids renamed and labels reworded;
   * "decoy" Save draft removed and Discard given its id;
   * "publish" the confirm dialog now publishes to every customer.
   */
  setSite(version: DemoSite): Promise<void>;
  reset(): Promise<void>;
  /** The server's own record: the saved note, its status, and what happened. */
  truth(): Promise<{ site: DemoSite; note: string; status: string; events: string[] }>;
  close(): Promise<void>;
}

/** Start the demo app on 127.0.0.1 (a free port unless you pass one). */
export function startApp(opts?: { port?: number }): Promise<DemoApp>;
