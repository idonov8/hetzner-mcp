import type { Server } from "node:http";
export const MOCK_TOKEN: string;
export const MOCK_TOKENS: { personal: string; we4water: string };
export const RATE_LIMITED_TOKEN: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(name: string): any;
export function respond(url: string, authorization: string | null | undefined): { status: number; body: unknown };
export function makeMockFetch(calls?: string[]): typeof fetch;
export function startMockServer(port?: number): Promise<{ server: Server; calls: string[]; port: number }>;
