// Build-time tool (Node only): reads every common/technologies/*.txt file (mod files
// override same-named vanilla files, matching how HOI4 actually loads mods) and derives a
// human category for each tech id. A tech's own `folder = { name = armour_folder }` field
// (the tab it's shown under in-game) only gives ~11 broad buckets across the whole mod — not
// fine enough to tell "tank chassis" techs from "tank gun" techs, which would both sit under
// the same armour folder. Instead, most techs also carry `enable_equipments = { archetype
// ... }` naming the exact equipment archetype they unlock — reusing the categorization
// already built in equipment-categories.json (tank_chassis.txt -> "Tank Chassis", etc.) for
// that archetype gives a far more precise label for free. Falls back to the folder name,
// prettified, only for techs with no equipment unlock (pure doctrine/industry techs).
// Bakes to tech-categories.json: { tech_id: { category, domain } }
//
// Re-run whenever the mod's technology or equipment files change:
//   node extract-tech-categories.js "<mod folder>" "<base game folder>"
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
	const chosen = [];
	for (const f of gameFiles) if (!modSet.has(f)) chosen.push(path.join(gameTechDir, f));
	for (const f of modFiles) chosen.push(path.join(modTechDir, f));
	return chosen;
}

// The mod's technology files only define 11 distinct folder names total (verified directly
// against every file in common/technologies), and several of those are just the same real
// category duplicated per DLC/mod source (e.g. armour_folder vs nsb_armour_folder are both
// just "Armour", split only because one was added by the No Step Back DLC and the other by
// the base file) — an explicit, exhaustively-checked list here instead of generic
// prettifying, so a DLC prefix like "Nsb"/"Bba" never leaks into the displayed label.
const FOLDER_CATEGORY = {
	armour_folder: { category: "Armour", domain: "army" },
	nsb_armour_folder: { category: "Armour", domain: "army" },
	TPMP_armour_support_folder: { category: "Armour Support", domain: "army" },
	air_techs_folder: { category: "Air", domain: "air" },
	bba_air_techs_folder: { category: "Air", domain: "air" },
	artillery_folder: { category: "Artillery", domain: "army" },
	electronics_folder: { category: "Electronics", domain: "other" },
	industry_folder: { category: "Industry", domain: "other" },
	infantry_folder: { category: "Infantry", domain: "army" },
	naval_folder: { category: "Naval", domain: "navy" },
	mtgnavalfolder: { category: "Naval", domain: "navy" },
	mtgnavalsupportfolder: { category: "Naval Support", domain: "navy" },
	support_folder: { category: "Support", domain: "army" },
};

function extractTechCategories(filePath, equipmentCategories, counts) {
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

		// enable_equipments={ archetype_1 archetype_2 ... } is a flat list of bare tokens, not
		// nested key=value pairs, so this just reads the first one directly rather than going
		// through walkAndCapture (which expects key={...}/key=value entries).
		const equipMatch = /(?:^|\n)\s*enable_equipments\s*=\s*\{\s*([A-Za-z0-9_]+)/.exec(techBody);
		if (equipMatch && equipmentCategories[equipMatch[1]]) {
			out[id] = equipmentCategories[equipMatch[1]];
			counts.fromEquipment++;
			continue;
		}

		const folderMatch = /folder\s*=\s*\{\s*name\s*=\s*([A-Za-z0-9_]+)/.exec(techBody);
		if (folderMatch) {
			const name = folderMatch[1];
			// Fallback for any folder name outside the verified list above (a mod update
			// adding a new one, say) — generic prettifying rather than dropping the tech
			// entirely, though FOLDER_CATEGORY should cover every name actually seen today.
			out[id] = FOLDER_CATEGORY[name] || { category: name.replace(/_?folder$/i, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || name, domain: "other" };
			counts.fromFolder++;
		}
	}
	return out;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-tech-categories.js <mod folder> <base game folder>");
		process.exit(1);
	}

	const equipmentCategories = JSON.parse(fs.readFileSync(path.join(__dirname, "equipment-categories.json"), "utf8"));

	const files = listFilesToProcess(modDir, gameDir);
	console.log(`Processing ${files.length} technology files...`);

	const out = {};
	const counts = { fromEquipment: 0, fromFolder: 0 };
	for (const filePath of files) {
		let categories;
		try {
			categories = extractTechCategories(filePath, equipmentCategories, counts);
		} catch (err) {
			console.warn(`Failed to parse ${filePath}: ${err.message}`);
			continue;
		}
		Object.assign(out, categories);
	}

	console.log(`Found a category for ${Object.keys(out).length} technologies (${counts.fromEquipment} via equipment unlock, ${counts.fromFolder} via folder fallback).`);
	fs.writeFileSync(path.join(__dirname, "tech-categories.json"), JSON.stringify(out));
	console.log("Wrote tech-categories.json");
}

main();
