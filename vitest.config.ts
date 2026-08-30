import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// vitest does not read tsconfig paths; the aliases must be duplicated here.
const pi = (pkg: string) => resolve(import.meta.dirname, `../pi/packages/${pkg}/src`);

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": pi("coding-agent"),
			"@earendil-works/pi-ai": pi("ai"),
			"@earendil-works/pi-ai/compat": resolve(pi("ai"), "compat.ts"),
			"@earendil-works/pi-agent-core": pi("agent"),
			"@earendil-works/pi-tui": pi("tui"),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
