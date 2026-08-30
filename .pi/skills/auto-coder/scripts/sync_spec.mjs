#!/usr/bin/env node
// Spec Sync (Node edition) — splits DEV_SPEC.md into chapter files and renders
// PROGRESS.md as a derived read-only view.
//
// The spec IS the state store: task checkboxes live in DEV_SPEC.md.
//
// Usage:
//   node scripts/sync_spec.mjs [--force]
//
// Env:
//   FIAT_SPEC_PATH  override spec path
//   FIAT_SKILL_DIR  override skill dir (mostly for tests)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SKILL_DIR_FROM_ENV = process.env.FIAT_SKILL_DIR;
const skillDir = SKILL_DIR_FROM_ENV ? resolve(SKILL_DIR_FROM_ENV) : resolve(dirname(new URL(import.meta.url).pathname), "..");

// Repo root = <repo>/.pi/skills/auto-coder -> ../../..
const DEFAULT_SPEC = resolve(skillDir, "../../../DEV_SPEC.md");
const specPath = process.env.FIAT_SPEC_PATH ? resolve(process.env.FIAT_SPEC_PATH) : DEFAULT_SPEC;

const refsDir = join(skillDir, "references");
const hashFile = join(skillDir, ".spec_hash");
const progressFile = join(skillDir, "PROGRESS.md");

const NUMBER_SLUG_MAP = {
	1: "positioning",
	2: "env-workspace",
	3: "l1-extensions",
	4: "l2-platform",
	5: "config",
	6: "dataflow",
	7: "testing",
	8: "schedule",
	9: "constraints",
};

/** Fallback chapter number if title matching fails. */
const FALLBACK_SCHEDULE_CHAPTER = 8;

function fail(msg) {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}

function slug(chapterNum, title) {
	if (NUMBER_SLUG_MAP[chapterNum]) return NUMBER_SLUG_MAP[chapterNum];
	const clean = title
		.toLowerCase()
		.replace(/[^\w]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return clean || `chapter-${chapterNum}`;
}

/** Split on `## N. Title` headings. */
function detectChapters(lines) {
	const starts = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^## (\d+)\.\s+(.+)$/.exec(lines[i]);
		if (m) starts.push({ num: Number(m[1]), title: m[2].trim(), start: i });
	}
	if (starts.length === 0) fail("no chapters found (expected '## N. Title')");
	return starts.map((s, idx) => {
		const end = idx + 1 < starts.length ? starts[idx + 1].start : lines.length;
		return { ...s, end, filename: `${String(s.num).padStart(2, "0")}-${slug(s.num, s.title)}.md` };
	});
}

function findScheduleChapter(chapters) {
	const byTitle = chapters.find((c) => /任务清单|schedule/i.test(c.title));
	return byTitle ?? chapters.find((c) => c.num === FALLBACK_SCHEDULE_CHAPTER);
}

const TASK_RE = /^[-*]\s*\[([ xX~])\]\s+(?:P(\d+)-(\d+)\s+)?(.+)$/;

/**
 * Parse the schedule chapter into tasks with status.
 * Expects `### 阶段 N：title` groups with `- [ ] P0-1 text` items.
 */
function parseTasks(lines) {
	const tasks = [];
	let stage = null;
	let stageTitle = "";
	for (const line of lines) {
		const stageMatch = /^###\s*阶段\s*(\d+)\s*[：:]?\s*(.*)$/.exec(line);
		if (stageMatch) {
			stage = Number(stageMatch[1]);
			stageTitle = stageMatch[2].trim();
			continue;
		}
		const m = TASK_RE.exec(line);
		if (m && stage !== null) {
			const marker = m[1].toLowerCase();
			tasks.push({
				stage,
				stageTitle,
				stageFromId: m[2] !== undefined ? Number(m[2]) : null,
				seq: m[3] !== undefined ? Number(m[3]) : tasks.length + 1,
				text: m[4].trim(),
				status: marker === "x" ? "done" : marker === "~" ? "doing" : "todo",
			});
		}
	}
	return tasks;
}

function renderProgress(tasks) {
	const out = [
		"# Progress (derived)",
		"",
		"> 自动生成，**改这里无效**。改进度请改 `DEV_SPEC.md` 里对应任务的 checkbox。",
		"",
	];
	let lastStage = -1;
	let done = 0;
	for (const task of tasks) {
		if (task.stage !== lastStage) {
			lastStage = task.stage;
			const stageTasks = tasks.filter((t) => t.stage === task.stage);
			const stageDone = stageTasks.filter((t) => t.status === "done").length;
			out.push("", `## 阶段 ${task.stage}：${task.stageTitle}  —  ${stageDone}/${stageTasks.length}`, "");
		}
		const marker = task.status === "done" ? "x" : task.status === "doing" ? "~" : " ";
		if (task.status === "done") done++;
		out.push(`- [${marker}] P${task.stage}-${task.seq} ${task.text}`);
	}
	out.push("", `**总计 ${done}/${tasks.length}**`, "");
	return { content: `${out.join("\n")}\n`, done };
}

function sync(force) {
	if (!existsSync(specPath)) fail(`spec not found: ${specPath}`);

	const currentHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
	const lines = readFileSync(specPath, "utf-8").split("\n");
	const chapters = detectChapters(lines);
	const schedule = findScheduleChapter(chapters);
	if (!schedule) fail("schedule chapter not found (expected a chapter titled with 任务清单/schedule)");
	const tasks = parseTasks(lines.slice(schedule.start, schedule.end));
	if (tasks.length === 0) fail(`no tasks parsed from chapter ${schedule.num} (${schedule.title})`);

	const stale = !existsSync(hashFile) || readFileSync(hashFile, "utf-8").trim() !== currentHash;

	if (stale || force) {
		mkdirSync(refsDir, { recursive: true });
		const existing = new Set(readdirSync(refsDir).filter((f) => f.endsWith(".md")));
		const wanted = new Set(chapters.map((c) => c.filename));
		for (const f of existing) {
			if (!wanted.has(f)) {
				unlinkSync(join(refsDir, f));
				console.log(`  removed orphan: ${f}`);
			}
		}
		for (const ch of chapters) {
			writeFileSync(join(refsDir, ch.filename), `${lines.slice(ch.start, ch.end).join("\n")}\n`, "utf-8");
		}
		writeFileSync(hashFile, currentHash, "utf-8");
		console.log(`synced ${chapters.length} chapters -> references/`);
	} else {
		console.log("spec unchanged, references up-to-date");
	}

	const { content, done } = renderProgress(tasks);
	writeFileSync(progressFile, content, "utf-8");

	console.log(`progress: ${done}/${tasks.length} done`);
	const next = tasks.find((t) => t.status === "doing") ?? tasks.find((t) => t.status === "todo");
	console.log(next ? `next: P${next.stage}-${next.seq} ${next.text}` : "next: (all tasks done)");
}

sync(process.argv.includes("--force"));
