import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent/core/skills.ts";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("Pi runtime is reachable from fiat-agent", () => {
	it("exposes the agent session SDK", () => {
		expect(typeof createAgentSession).toBe("function");
	});

	it("exposes the faux provider used for offline extension tests", () => {
		expect(typeof registerFauxProvider).toBe("function");
	});

	it("discovers the auto-coder skill from the workspace", () => {
		const { skills, diagnostics } = loadSkills({
			cwd: REPO_ROOT,
			agentDir: "/Users/tog/.pi/agent",
			skillPaths: [],
			includeDefaults: true,
		});
		const names = skills.map((s) => s.name);
		expect(names).toContain("auto-coder");
		expect(diagnostics).toHaveLength(0);
	});
});
