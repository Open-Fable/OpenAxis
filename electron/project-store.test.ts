import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFiles = new Map<string, string>();

vi.mock("fs", () => ({
  promises: {
    mkdir: vi.fn(() => Promise.resolve()),
    readFile: vi.fn((p: string) => {
      const data = mockFiles.get(p);
      if (data) return Promise.resolve(data);
      return Promise.reject(new Error("ENOENT"));
    }),
    writeFile: vi.fn((p: string, content: string) => {
      mockFiles.set(p, content);
      return Promise.resolve();
    }),
    rename: vi.fn((from: string, to: string) => {
      const data = mockFiles.get(from);
      if (data) {
        mockFiles.set(to, data);
        mockFiles.delete(from);
      }
      return Promise.resolve();
    }),
  },
}));

vi.mock("crypto", () => ({
  randomBytes: vi.fn((n: number) => ({
    toString: () => "a".repeat(n * 2),
  })),
}));

describe("project-store", () => {
  beforeEach(() => {
    mockFiles.clear();
    vi.resetModules();
  });

  it("creates initial projects when no file exists", async () => {
    const { getProjects } = await import("./project-store.js");
    const projects = await getProjects();
    expect(projects.length).toBe(6);
    expect(projects[0].name).toBe("API Backend — Authentification");
  });

  it("getActiveProject returns the active project", async () => {
    const { getActiveProject } = await import("./project-store.js");
    const active = await getActiveProject();
    expect(active).not.toBeNull();
    expect(active!.id).toBe("p4");
  });

  it("saveProject creates a new project with default color", async () => {
    const { saveProject, getProjects } = await import("./project-store.js");
    const created = await saveProject({ name: "Test Project" });
    expect(created.name).toBe("Test Project");
    expect(created.color).toBeTruthy();
    const all = await getProjects();
    expect(all.length).toBe(7);
  });

  it("saveProject updates an existing project", async () => {
    const { saveProject, getProjects } = await import("./project-store.js");
    await saveProject({ id: "p1", name: "Updated Name" });
    const all = await getProjects();
    const updated = all.find((p) => p.id === "p1");
    expect(updated!.name).toBe("Updated Name");
  });

  it("deleteProject removes project and clears active if needed", async () => {
    const { deleteProject, getProjects, getActiveProjectId } =
      await import("./project-store.js");
    await deleteProject("p4");
    const projects = await getProjects();
    expect(projects.find((p) => p.id === "p4")).toBeUndefined();
    const active = await getActiveProjectId();
    expect(active).toBeNull();
  });

  it("setActiveProject ignores non-existent id", async () => {
    const { setActiveProject, getActiveProjectId } = await import("./project-store.js");
    await setActiveProject("non-existent");
    const active = await getActiveProjectId();
    expect(active).toBe("p4");
  });

  it("setActiveProject accepts null", async () => {
    const { setActiveProject, getActiveProjectId } = await import("./project-store.js");
    await setActiveProject(null);
    const active = await getActiveProjectId();
    expect(active).toBeNull();
  });
});

describe("project-store — workflows", () => {
  beforeEach(() => {
    mockFiles.clear();
    vi.resetModules();
  });

  it("creates default workflow on first load", async () => {
    const { getWorkflows } = await import("./project-store.js");
    const workflows = await getWorkflows();
    expect(workflows.length).toBe(1);
    expect(workflows[0].name).toBe("Refonte onboarding");
  });

  it("saveWorkflow creates a new workflow", async () => {
    const { saveWorkflow, getWorkflows } = await import("./project-store.js");
    await saveWorkflow({
      name: "Test Workflow",
      orchProjectId: "p1",
      linkedProjectIds: ["p2"],
      agentTypes: { p2: "code" },
    });
    const all = await getWorkflows();
    expect(all.length).toBe(2);
  });

  it("deleteWorkflow removes a workflow", async () => {
    const { deleteWorkflow, getWorkflows } = await import("./project-store.js");
    await deleteWorkflow("wf-default");
    const all = await getWorkflows();
    expect(all.length).toBe(0);
  });
});
