// scripts/switch-pi-deps.mjs
// Toggles fiat-agent-pi between the registry-pinned Pi (0.80.3) and local source
// links (../pi). Mirrors the dependency-resolution discipline from DEV_SPEC §2.5 /
// P7-31: deep-diving into Pi internals temporarily switches back to local source,
// then switches back to the pinned registry version.
//
// Usage:
//   node scripts/switch-pi-deps.mjs local      # file: links + tsconfig paths -> ../pi/src
//   node scripts/switch-pi-deps.mjs registry   # pinned 0.80.3 + tsconfig paths removed
//
// The npm scripts wrap this with the reinstall step:
//   npm run dev:pi-local | npm run dev:pi-registry
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const mode = process.argv[2];
if (mode !== "local" && mode !== "registry") {
	console.error("Usage: node scripts/switch-pi-deps.mjs <local|registry>");
	process.exit(1);
}

const PIN = "0.80.3";
const pkgs = [
	{ scope: "pi-agent-core", dir: "agent" },
	{ scope: "pi-ai", dir: "ai" },
	{ scope: "pi-coding-agent", dir: "coding-agent" },
	{ scope: "pi-tui", dir: "tui" },
];

// 1) package.json dependencies
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
for (const p of pkgs) {
	const name = `@earendil-works/${p.scope}`;
	if (!(name in pkg.dependencies)) {
		console.error(`WARN: ${name} not present in dependencies, skipping`);
		continue;
	}
	pkg.dependencies[name] =
		mode === "local" ? `file:../pi/packages/${p.dir}` : PIN;
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2) tsconfig paths (typecheck -> dist, runtime -> src for local debug)
function makePaths(sub) {
	const paths = {};
	for (const p of pkgs) {
		const name = `@earendil-works/${p.scope}`;
		const ext = sub === "dist" ? "d.ts" : "ts";
		paths[name] = [`../pi/packages/${p.dir}/${sub}/index.${ext}`];
		paths[`${name}/*`] = [`../pi/packages/${p.dir}/${sub}/*`];
	}
	return paths;
}

for (const t of ["tsconfig.json", "tsconfig.runtime.json"]) {
	const tPath = join(root, t);
	if (!existsSync(tPath)) continue;
	const ts = JSON.parse(readFileSync(tPath, "utf8"));
	ts.compilerOptions = ts.compilerOptions || {};
	if (mode === "registry") {
		delete ts.compilerOptions.paths;
	} else {
		// tsconfig.json = typecheck (dist); tsconfig.runtime.json = runtime (src)
		ts.compilerOptions.paths = makePaths(t === "tsconfig.json" ? "dist" : "src");
	}
	writeFileSync(tPath, JSON.stringify(ts, null, 2) + "\n");
}

console.log(
	`[switch-pi-deps] -> ${mode} mode (Pi @ ${mode === "registry" ? PIN : "../pi"})`,
);
