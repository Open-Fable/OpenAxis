// OpenHub — Shared type definitions

export type SlotName = "work" | "code" | "design" | "chat" | "config";

export interface SlotConfig {
  readonly name: SlotName;
  readonly label: string;
  readonly port: number | null;
  readonly url: string;
  readonly icon: string;
}

export interface AppProcess {
  readonly slot: SlotName;
  readonly pid: number;
  readonly port: number;
  readonly healthy: boolean;
}

export interface ProxyRoute {
  readonly modelPattern: string;
  readonly provider: "anthropic" | "openai" | "ollama";
  readonly baseUrl: string;
}

export interface OverrideEntry {
  readonly file: string;
  readonly type: "css" | "js";
  readonly enabled: boolean;
}

export interface KeychainSecret {
  readonly service: string;
  readonly account: string;
}
