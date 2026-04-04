// ---------------------------------------------------------------------------
// Shared schema readiness flag.
// Extracted here so app.ts and server.ts can both reference it without
// creating a circular dependency.
// ---------------------------------------------------------------------------
export let schemaReady = false;

export function setSchemaReady(value: boolean): void {
  schemaReady = value;
}
