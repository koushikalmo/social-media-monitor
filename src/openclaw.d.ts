// loose stubs so this builds without `openclaw` installed locally;
// the gateway provides the real implementation at runtime

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface ToolResultText {
    type: "text";
    text: string;
  }

  export interface ToolResult {
    content: ToolResultText[];
  }

  export interface RegisterToolSpec {
    name: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
  }

  export interface PluginApi {
    registerTool(spec: RegisterToolSpec): void;
    runtime?: { workspace?: string };
  }

  export interface PluginEntrySpec {
    id: string;
    name: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(spec: PluginEntrySpec): unknown;
}
