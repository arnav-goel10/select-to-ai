// Type declarations for @recipes/core (hand-written).

/* ----------------------------- the page ----------------------------- */

/** One control (or, for read steps, one piece of text) as a driver reports it. */
export interface SnapshotElement {
  /** Stable while the element lives: "f<frame>e<n>". */
  ref: string;
  frame: number;
  tag: string;
  /** Explicit or implicit ARIA role: button, link, textbox, searchbox, combobox, checkbox, ... ("text" for text items). */
  kind: string;
  /** Accessible name. */
  name: string;
  /** aria-label. */
  label: string;
  text: string;
  placeholder: string;
  title: string;
  /** The name attribute. */
  nameAttr: string;
  htmlId: string;
  /** First of data-testid, data-test, data-qa, data-cy. */
  testId: string;
  autocomplete: string;
  inputType: string;
  href: string;
  /** The container's label: an item's text, a dialog's or form's label. */
  group: string;
  groupKind: "item" | "form" | "search" | "dialog" | "navigation" | "sidebar" | "footer" | "group" | "";
  groupKey: string;
  /** Text of the nearest heading above. */
  heading: string;
  /** Header text of the table column a cell is in. */
  column?: string;
  /** Up to 4 labelled or landmark ancestors, innermost first. */
  ancestors: string[];
  /** Up to 4 neighbouring texts. */
  siblings: string[];
  rect: { x: number; y: number; w: number; h: number };
  /** False when something else is on top of its centre. */
  onTop: boolean;
  disabled: boolean;
  /** "password" | "card" | "code" | "". */
  sensitive: string;
  editable: boolean;
  /** Submits its form. */
  submits: boolean;
  form: { action: string; method: string; search: boolean; fields: number; key: string } | null;
  value?: string;
  checked?: boolean;
  options?: string[];
  optionValues?: string[];
  selectedText?: string;
  min?: string;
  max?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  /** First headings (h1-h3). */
  outline: string[];
  /** Visible text of the page. */
  text: string;
  viewport: { w: number; h: number };
  elements: SnapshotElement[];
  /** Text items, only when asked for ({texts: true}). */
  texts?: SnapshotElement[];
  /** HTTP status of the last main document, when known. */
  status?: number;
  /** For each probed locator: how many elements it matches, and the ref when exactly one. */
  locs?: Record<string, { n: number; refs: string[] }>;
}

export type DriverAction =
  | { do: "navigate"; url: string }
  | { do: "back" }
  | { do: "click" | "hover"; ref: string }
  | { do: "fill"; ref: string; value: string }
  | { do: "press"; key: string; ref?: string };

export interface Download { name: string; path: string | null; bytes: number; sha256: string; at: number }

export interface ActResult {
  ok: boolean;
  error?: string;
  settleMs?: number;
  /** Requests the action caused (method, url); a non-GET marks a step as commit at record time. */
  requests?: { method: string; url: string }[];
  downloads?: Download[];
}

/** How the core reaches a browser. The Playwright driver and the extension each provide one. */
export interface RecipeDriver {
  snapshot(opts?: { texts?: boolean }): Promise<Snapshot>;
  /** Turn whatever the caller recorded with (a locator, a selector, {ref}) into a snapshot element. */
  /** `loc` is the caller's selector text when there is one (kept as evidence). */
  locate(target: unknown): Promise<{ ref: string | null; el: SnapshotElement | null; loc?: string | null }>;
  /** Never throws: failures come back as {ok:false}. */
  act(action: DriverAction): Promise<ActResult>;
  /** Re-check on every DOM change (or a short poll) until check() is true or the deadline passes. */
  waitForState(check: (s: Snapshot) => boolean, opts: { deadlineMs: number; texts?: boolean; probes?: string[] | null }): Promise<{ held: boolean; snapshot: Snapshot; elapsedMs: number }>;
  readFile?(path: string): Promise<Uint8Array>;
  screenshot?(): Promise<string>;
}

/* ----------------------------- the model ----------------------------- */

export interface ModelUsage { provider?: string; model: string; inTok: number; outTok: number; ms?: number; usd?: number }

export interface ModelClient {
  name?: string;
  model?: string;
  complete(req: { system: string; user: string; schema: object; image?: string }): Promise<{ json: any; usage: ModelUsage }>;
}

/* ----------------------------- recipes ----------------------------- */

export type StepClass = "read" | "edit" | "commit";
export interface UrlPattern { origin: string; path: string; query: Record<string, string> }

export interface Fingerprint {
  attrs: Record<string, any> & { kind: string; ordinal: { of: number; n: number }; frame: number; onTop: boolean };
  weights: Record<string, number>;
  scope?: { groupKind: "item"; contains: string };
  ambiguousAtRecord: number;
  read?: boolean;
  /** The developer's own locator (a Playwright selector), kept as evidence only; never acted on directly. */
  loc?: string;
}

export type Predicate =
  | { k: "url"; match: UrlPattern }
  /** The address as recorded, or the same site showing the page's heading (after a redirect or a moved path). */
  | { k: "page"; match: UrlPattern; heading?: string; rel?: { up: number; tail: string[] } }
  | { k: "title"; words: string[] }
  | { k: "appears"; target: Fingerprint; minScore: number }
  | { k: "gone"; target: Fingerprint; minScore?: number }
  | { k: "value"; of: string; equals: string }
  | { k: "text"; contains: string; where?: "visible" | "page" }
  | { k: "download"; ext?: string }
  | { k: "changed" };

export type Action =
  | { do: "navigate"; url: string }
  | { do: "click" | "hover" }
  | { do: "fill"; value: string }
  | { do: "press"; key: string; onTarget: boolean }
  | { do: "back" }
  | { do: "read"; name: string };

export interface Step {
  id: string;
  intent: string;
  class: StepClass;
  risk: string[];
  pre: { page: { url: UrlPattern | null; titleWords: string[]; outline: string[]; forms: { action: string; labels: string[] }[] }; targetPresent: boolean; noBlockers: boolean };
  action: Action;
  target: Fingerprint | null;
  post: { all: Predicate[]; strength: "strong" | "weak" };
  wait: { recordedSettleMs: number; deadlineMs: number };
  /** Inserted by a repair: skipped when its control is not there. */
  optional?: boolean;
}

export interface Variable {
  name: string;
  type: "text" | "enum" | "date" | "number" | "profile" | "secret";
  required: boolean;
  example?: string;
  default?: string;
  enum?: string[];
  format?: string;
  min?: number;
  max?: number;
  source: "request" | "user_typed" | "profile" | "user_marked";
  checked: "second_value" | "preview" | "none";
}

export interface Recipe {
  schema: "select-to-ai.recipe/1";
  id: string;
  lineage: string;
  title: string;
  request: string;
  sites: string[];
  start: { url: UrlPattern | null; newTab: boolean };
  variables: Variable[];
  steps: Step[];
  result: { kind: "action" | "extract"; extract?: { name: string; at: string }[]; answer?: string; done: Predicate[] };
  state: "draft" | "verified" | "degraded" | "imported" | "retired";
  trust: null;
  schedule: null;
  provenance: { source: string; compiledAt: number; compiler: string; author: string };
  versions: { v: number; at: number; by: string; parent: number | null; ops: any[]; steps: Step[]; receiptId?: string; status: string }[];
  active: number;
  counters: Record<string, any>;
}

/* ----------------------------- receipts ----------------------------- */

export type EndState = "done_proven" | "done_unproven" | "needs_you" | "stopped" | "failed";

export interface Receipt {
  id: string;
  kind: "replay";
  recipeId: string;
  recipeVersion: number;
  startedAt: number;
  endedAt: number;
  request: string;
  variables: { name: string; shown: string }[];
  steps: {
    id: string; n: number; intent: string; class: StepClass; action: string;
    status: "ok" | "already" | "skipped" | "failed";
    resolution: { method: "exact" | "fingerprint" | "repair" | "none"; score: number; margin: number; ranked: { label: string; score: number }[] } | null;
    target: string | null;
    post: { predicate: string; held: boolean; observed: string }[];
    value?: string; settleMs: number; waitedMs: number;
  }[];
  repairs: { step: string; patch: string; status: "persisted" | "rolled_back" | "failed" | "rejected" | "needs_you" | "trial"; diffText: string; model?: string; why?: string; review?: boolean }[];
  end: { state: EndState; proof: { kind: "postconditions" | "none"; items: { what: string; quote?: string; url?: string }[] }; why: string };
  /** True when a repair was applied, verified to the end, and saved in `recipe`. */
  healed: boolean;
  answer?: string;
  extracts: Record<string, string>;
  downloads: { name: string; bytes: number; sha256: string; path: string | null }[];
  cost: { modelCalls: number; promptTokens: number; completionTokens: number; usd: number; models: string[] };
  /** How many meaning checks ran (each one is a model call when repair is on). */
  checks: { drift: number };
  drift: { step: string; attrs: string[] }[];
  trace: string[];
  /** The recipe to save: a new version after a verified repair, and updated counters and state. */
  recipe: Recipe;
}

/* ----------------------------- API ----------------------------- */

export type Target = unknown; // a Playwright Locator, an ElementHandle, a selector string, or {ref}

export interface RecorderApi {
  goto(url: string): Promise<void>;
  back(): Promise<void>;
  click(target: Target, opts?: { intent?: string; class?: StepClass }): Promise<ActResult>;
  hover(target: Target, opts?: { intent?: string }): Promise<ActResult>;
  /** value may be "{var}" or a literal equal to a variable's value. */
  fill(target: Target, value: string, opts?: { intent?: string; class?: StepClass }): Promise<ActResult>;
  select(target: Target, value: string, opts?: { intent?: string }): Promise<ActResult>;
  check(target: Target, opts?: { intent?: string }): Promise<ActResult>;
  uncheck(target: Target, opts?: { intent?: string }): Promise<ActResult>;
  press(target: Target, key: string, opts?: { intent?: string; class?: StepClass }): Promise<ActResult>;
  press(key: string): Promise<ActResult>;
  download(target: Target, opts?: { intent?: string }): Promise<Download>;
  read(target: Target, name?: string, opts?: { intent?: string }): Promise<string>;
  /** Text that proves the whole task is done; checked at the end of every replay. */
  expectText(text: string): Promise<void>;
  /** The same Page with its actions recorded (Playwright only). */
  page: any;
  driver: RecipeDriver;
}

export interface ReplayOptions {
  vars?: Record<string, unknown>;
  /** Repair is off unless a model is given. Commit steps are never repaired without approve(). */
  repair?: { model?: ModelClient; approve?: (proposal: { step: string; text: string; why: string }) => Promise<boolean>; maxRepairs?: number } | false;
  thresholds?: Partial<typeof THRESHOLDS>;
  onEvent?: (e: { effect?: any; event?: any }) => void;
  deadlineMs?: number;
  driver?: { actionTimeoutMs?: number; settleQuietMs?: number; settleMaxMs?: number; downloadDir?: string };
}

/**
 * opts.secrets: an object the recorder fills with any password, card or code
 * typed during recording ({password: "..."}). Those values are never stored
 * in the recipe; pass them back in replay's vars.
 */
export function record(page: any, script: (r: RecorderApi) => Promise<void>, opts?: { vars?: Record<string, string>; secrets?: Record<string, string>; title?: string; request?: string; driver?: ReplayOptions["driver"] }): Promise<Recipe>;
export function replay(page: any, recipe: Recipe, opts?: ReplayOptions): Promise<Receipt>;

export function validate(recipe: unknown): { ok: boolean; errors: string[] };
export const SCHEMA: "select-to-ai.recipe/1";
export const THRESHOLDS: { tau: number; mu: number; tauCommit: number; muCommit: number; labelFloor: number; tauLocator: number; driftSim: number };
export const WEIGHTS: Record<string, number>;
export function headline(receipt: Pick<Receipt, "end" | "request" | "healed">): string;
export function toMarkdown(receipt: Receipt): string;
