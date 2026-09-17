// Build-time tool (Node only): scans common/ideas/*.txt (mod + base game, mod files
// override same-named vanilla files, matching how HOI4 actually loads mods) to figure out
// which idea tokens are LAWS (idea categories flagged law=yes) vs everything else, so the
// app can tell "a law changed" apart from "a national spirit/advisor idea appeared" instead
// of lumping every entry in politics.ideas together.
//
// Also resolves idea display names from localisation, same approach as extract-focus-trees.js.
//
// Re-run whenever the mod's common/ideas files change:
//   node extract-idea-metadata.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");
const { walkAndCapture, skipValue } = require("./parser.js");

function stripComments(text) {
	const lines = text.split("\n");
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		let inQuote = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === '"') inQuote = !inQuote;
			else if (c === "#" && !inQuote) { lines[li] = line.slice(0, i); break; }
		}
	}
	return lines.join("\n");
}

function loadLocalisation(dirs) {
	const map = new Map();
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".yml")) continue;
			const text = fs.readFileSync(path.join(dir, file), "utf8");
			const re = /^\s*([A-Za-z0-9_.\-]+):\d*\s*"(.*)"\s*$/gm;
			let m;
			while ((m = re.exec(text)) !== null) map.set(m[1], m[2]);
		}
	}
	return map;
}

function listFilesToProcess(modDir, gameDir) {
	const modIdeasDir = path.join(modDir, "common", "ideas");
	const gameIdeasDir = path.join(gameDir, "common", "ideas");
	const modFiles = fs.existsSync(modIdeasDir) ? fs.readdirSync(modIdeasDir).filter((f) => f.endsWith(".txt")) : [];
	const gameFiles = fs.existsSync(gameIdeasDir) ? fs.readdirSync(gameIdeasDir).filter((f) => f.endsWith(".txt")) : [];
	const modSet = new Set(modFiles);
	// File-level override: a mod file with the same name entirely replaces the vanilla one.
	const chosen = [];
	for (const f of gameFiles) if (!modSet.has(f)) chosen.push(path.join(gameIdeasDir, f));
	for (const f of modFiles) chosen.push(path.join(modIdeasDir, f));
	return chosen;
}

function extractIdeaCategories(filePath) {
	const raw = stripComments(fs.readFileSync(filePath, "utf8"));
	const ideasIdx = raw.search(/(?:^|\n)\s*ideas\s*=\s*\{/);
	if (ideasIdx === -1) return [];
	const braceIdx = raw.indexOf("{", ideasIdx);
	const end = skipValue(raw, braceIdx);
	const body = raw.slice(braceIdx + 1, end - 1);
	const categories = walkAndCapture(body, () => true);
	const out = [];
	for (const [catName, catBodies] of categories) {
		for (const catBody of catBodies) {
			const isLaw = /(?:^|\n)\s*law\s*=\s*yes/.test(catBody);
			const entries = walkAndCapture(catBody, () => true);
			const ids = [...entries.keys()].filter((k) => k !== "law" && k !== "use_list_view" && k !== "designer");
			// Keep each idea's own body too, so its exact `cost = N` field (the real PP price
			// to switch to it) can be read directly instead of guessed at from save-balance math.
			const bodyById = new Map(ids.map((id) => [id, (entries.get(id) || [])[0] || ""]));
			out.push({ category: catName, isLaw, ids, bodyById });
		}
	}
	return out;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-idea-metadata.js <mod folder> <base game folder>");
		process.exit(1);
	}

	const loc = loadLocalisation([
		path.join(gameDir, "localisation", "english"),
		path.join(modDir, "localisation", "english"),
	]);

	const files = listFilesToProcess(modDir, gameDir);
	console.log(`Processing ${files.length} idea files...`);

	const lawIds = new Set();
	const categoryOf = new Map(); // idea id -> category name (for display, e.g. "Economy Law")
	const costOf = new Map(); // idea id -> exact cost = N field from its own definition
	const levelOf = new Map(); // idea id -> level = N field, when present
	let categoriesWithLaw = 0;

	for (const filePath of files) {
		let cats;
		try {
			cats = extractIdeaCategories(filePath);
		} catch (err) {
			console.warn(`Failed to parse ${filePath}: ${err.message}`);
			continue;
		}
		for (const cat of cats) {
			if (cat.isLaw) {
				categoriesWithLaw++;
				for (const id of cat.ids) {
					lawIds.add(id);
					categoryOf.set(id, cat.category);
					const body = cat.bodyById.get(id) || "";
					const costMatch = /(?:^|\n)\s*cost\s*=\s*(-?\d+(?:\.\d+)?)/.exec(body);
					if (costMatch) costOf.set(id, Number(costMatch[1]));
					// Some law groups (this mod: Procurement/military industry, Army
					// Professionalism/training, Mobilization Laws/conscription) are leveled
					// progressions — `cost` there is the price PER LEVEL STEP, not a flat
					// price, so jumping from level 1 to level 3 costs 2x cost, not 1x. Groups
					// without a `level` field (Economy, Trade Laws here) are flat swaps.
					const levelMatch = /(?:^|\n)\s*level\s*=\s*(\d+)/.exec(body);
					if (levelMatch) levelOf.set(id, Number(levelMatch[1]));
				}
			}
		}
	}

	console.log(`Found ${categoriesWithLaw} law categories, ${lawIds.size} law idea ids, ${costOf.size} with an explicit cost.`);

	const prettifyCategory = (c) => c.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
	const lawMeta = {};
	for (const id of lawIds) {
		lawMeta[id] = {
			name: loc.get(id) && !loc.get(id).includes("[") ? loc.get(id) : id,
			category: prettifyCategory(categoryOf.get(id) || ""),
			// Real PP price to switch to this law, straight from its `cost = N` field — not
			// inferred from save-balance math. null when a law has no cost field at all
			// (rare; treat as unknown rather than assuming a number). For a leveled group
			// this is the per-level price; `level` (below) says which rung this entry is.
			cost: costOf.has(id) ? costOf.get(id) : null,
			level: levelOf.has(id) ? levelOf.get(id) : null,
		};
	}

	fs.writeFileSync(path.join(__dirname, "law-ideas.json"), JSON.stringify(lawMeta));
	console.log("Wrote law-ideas.json");
}

main();
