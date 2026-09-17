// Build-time tool (Node only): reads every common/technologies/*.txt file (mod files
// override same-named vanilla files, matching how HOI4 actually loads mods) and pulls out
// each tech's `start_year` — the field HOI4 itself uses to calculate "how far ahead of
// schedule" a completed tech was. Bakes them into tech-years.json: { tech_id: year }.
//
// Re-run whenever the mod's technology files change:
//   node extract-tech-years.js "<mod folder>" "<base game folder>"
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
			else if (c === "#" && !inQuote) {
				lines[li] = line.slice(0, i);
				break;
			}
		}
	}
	return lines.join("\n");
}

function listFilesToProcess(modDir, gameDir) {
	const modTechDir = path.join(modDir, "common", "technologies");
	const gameTechDir = path.join(gameDir, "common", "technologies");
	const modFiles = fs.existsSync(modTechDir) ? fs.readdirSync(modTechDir).filter((f) => f.endsWith(".txt")) : [];
	const gameFiles = fs.existsSync(gameTechDir) ? fs.readdirSync(gameTechDir).filter((f) => f.endsWith(".txt")) : [];
	const modSet = new Set(modFiles);
	// File-level override: a mod file with the same name entirely replaces the vanilla one.
	const chosen = [];
	for (const f of gameFiles) if (!modSet.has(f)) chosen.push(path.join(gameTechDir, f));
	for (const f of modFiles) chosen.push(path.join(modTechDir, f));
	return chosen;
}

function extractTechYears(filePath) {
	const raw = stripComments(fs.readFileSync(filePath, "utf8"));
	const idx = raw.search(/(?:^|\n)\s*technologies\s*=\s*\{/);
	if (idx === -1) return {};
	const braceIdx = raw.indexOf("{", idx);
	const end = skipValue(raw, braceIdx);
	const body = raw.slice(braceIdx + 1, end - 1);
	const entries = walkAndCapture(body, () => true);
	const out = {};
	for (const [id, bodies] of entries) {
		const techBody = bodies[0];
		const m = /(?:^|\n)\s*start_year\s*=\s*(-?\d+)/.exec(techBody);
		if (m) out[id] = Number(m[1]);
	}
	return out;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-tech-years.js <mod folder> <base game folder>");
		process.exit(1);
	}

	const files = listFilesToProcess(modDir, gameDir);
	console.log(`Processing ${files.length} technology files...`);

	const out = {};
	for (const filePath of files) {
		let years;
		try {
			years = extractTechYears(filePath);
		} catch (err) {
			console.warn(`Failed to parse ${filePath}: ${err.message}`);
			continue;
		}
		Object.assign(out, years);
	}

	console.log(`Found start_year for ${Object.keys(out).length} technologies.`);
	fs.writeFileSync(path.join(__dirname, "tech-years.json"), JSON.stringify(out));
	console.log("Wrote tech-years.json");
}

main();
