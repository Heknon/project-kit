import { KitError, type Scope } from "./settings";

const API = "https://api.vercel.com";

export class Vercel {
  constructor(
    private readonly token: string,
    private readonly teamId?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, API);
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) throw new NotFound(path);
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new KitError(`Vercel ${method} ${url.pathname} failed (${response.status}): ${detail.error?.message ?? response.statusText}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async teams(): Promise<{ id: string; slug: string; name: string }[]> {
    const result = await this.request<{ teams: { id: string; slug: string; name: string }[] }>("GET", "/v2/teams");
    return result.teams;
  }

  async project(nameOrId: string): Promise<VercelProject | null> {
    try {
      return await this.request<VercelProject>("GET", `/v9/projects/${encodeURIComponent(nameOrId)}`);
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async domains(projectId: string): Promise<{ name: string; gitBranch: string | null }[]> {
    const result = await this.request<{ domains: { name: string; gitBranch: string | null }[] }>(
      "GET",
      `/v9/projects/${projectId}/domains?limit=100`,
    );
    return result.domains;
  }

  async envKeys(projectId: string): Promise<VercelEnv[]> {
    const result = await this.request<{ envs: VercelEnv[] }>("GET", `/v10/projects/${projectId}/env`);
    return result.envs;
  }

  /** Upserts a sensitive variable for one scope; the value is never read back. */
  async setSecret(projectId: string, key: string, value: string, scope: Scope): Promise<void> {
    for (const target of scopeTargets(scope)) {
      await this.request("POST", `/v10/projects/${projectId}/env?upsert=true`, {
        key,
        value,
        type: "sensitive",
        target: [target.target],
        gitBranch: target.gitBranch,
      });
    }
  }

  async deleteEnv(projectId: string, envId: string): Promise<void> {
    await this.request("DELETE", `/v9/projects/${projectId}/env/${envId}`);
  }

  async disconnectGit(projectId: string): Promise<void> {
    await this.request("DELETE", `/v9/projects/${projectId}/link`);
  }
}

export interface VercelProject {
  id: string;
  name: string;
  link?: { type: string; repo?: string; org?: string };
}

export interface VercelEnv {
  id: string;
  key: string;
  target?: string[];
  gitBranch?: string;
  configurationId?: string | null;
  contentHint?: { type?: string; integrationId?: string } | null;
}

export function scopeTargets(scope: Scope): { target: "production" | "preview"; gitBranch?: string }[] {
  switch (scope) {
    case "production":
      return [{ target: "production" }];
    case "preview":
    case "nonproduction":
      return [{ target: "preview" }];
    case "dev":
      return [{ target: "preview", gitBranch: "dev" }];
  }
}

/** Variables a Vercel Marketplace integration manages; the kit replaces them. */
export function integrationVariables(envs: VercelEnv[]): string[] {
  return envs.filter((env) => env.configurationId || env.contentHint?.integrationId).map((env) => env.key);
}

class NotFound extends KitError {}
