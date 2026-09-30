/**
 * Minimal ambient declaration for the 'ws' package — a worker-only runtime
 * dependency (dynamically imported in main.ts, never bundled into the Vite
 * frontend). No @types/ws package is installed; this is intentionally
 * loose (matches only what kiteDepthSource.ts's WebSocketLike interface
 * actually uses) rather than a full type surface.
 */
declare module 'ws' {
  export default class WebSocket {
    constructor(url: string);
    send(data: string | Buffer): void;
    close(): void;
    on(event: string, handler: (...args: any[]) => void): void;
  }
}
