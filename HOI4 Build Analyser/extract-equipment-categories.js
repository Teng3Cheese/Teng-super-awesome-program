// Build-time tool (Node only): reads every common/units/equipment/*.txt file (mod files
// override same-named vanilla files, matching how HOI4 actually loads mods) and maps each
// equipment archetype id (e.g. "light_tank_chassis_1936") to a human category, using the
// FILE it's defined in as the category — HOI4's own equipment files are already organized
// this way (tank_chassis.txt, infantry.txt, convoys.txt, ship_hull_carrier.txt, etc.), so
// no guessing at categorization is needed. Bakes to equipment-categories.json:
//   { archetype_id: { category: "Tank Chassis", domain: "army"|"navy"|"air"|"other" } }
//
// Re-run whenever the mod's equipment files change:
//   node extract-equipment-categories.js "<mod folder>" "<base game folder>"
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
	const modEqDir = path.join(modDir, "common", "units", "equipment");
	const gameEqDir = path.join(gameDir, "common", "units", "equipment");
	const modFiles = fs.existsSync(modEqDir) ? fs.readdirSync(modEqDir).filter((f) => f.endsWith(".txt")) : [];
	const gameFiles = fs.existsSync(gameEqDir) ? fs.readdirSync(gameEqDir).filter((f) => f.endsWith(".txt")) : [];
	const modSet = new Set(modFiles);
	const chosen = [];
	for (const f of gameFiles) if (!modSet.has(f)) chosen.push({ file: path.join(gameEqDir, f), name: f });
	for (const f of modFiles) chosen.push({ file: path.join(modEqDir, f), name: f });
	return chosen;
}

// Filenames -> a broad domain, just for a quick land/navy/air split alongside the specific
// category — best-effort, unknown ones just fall back to "other".
function guessDomain(fileBase) {
	if (/^ship_hull|^support_ships|^repair_ships|^convoys|^floating_harbor|^mothership/.test(fileBase)) return "navy";
	if (/plane_airframe|^helicopter|^x_plane/.test(fileBase)) return "air";
	if (/^tank_chassis|^x_tank_chassis|^infantry|^artillery|^heavy_artillery|^anti_air|^heavy_anti_air|^anti_tank|^heavy_anti_tank|^motorized|^mechanized|^armored_car|^amphibious|^support$|^special$|^specialist_armored_vehicles|^railway_gun|^super_heavy_railway_gun|^trains|^emplacement_gun_ammo/.test(fileBase)) return "army";
	return "other";
}

function prettify(fileBase) {
	return fileBase.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error("Usage: node extract-equipment-categories.js <mod folder> <base game folder>");
		process.exit(1);
	}

	const files = listFilesToProcess(modDir, gameDir);
	console.log(`Processing ${files.length} equipment files...`);

	const out = {};
	for (const { file, name } of files) {
		const fileBase = name.replace(/\.txt$/, "");
		const category = prettify(fileBase);
		const domain = guessDomain(fileBase);
		let raw;
		try {
			raw = stripComments(fs.readFileSync(file, "utf8"));
		} catch (err) {
			continue;
		}
		const idx = raw.search(/(?:^|\n)\s*equipments\s*=\s*\{/);
		if (idx === -1) continue;
		const braceIdx = raw.indexOf("{", idx);
		const end = skipValue(raw, braceIdx);
		const body = raw.slice(braceIdx + 1, end - 1);
		const entries = walkAndCapture(body, () => true);
		for (const id of entries.keys()) {
			out[id] = { category, domain };
		}
	}

	console.log(`Found ${Object.keys(out).length} equipment archetypes across ${files.length} files.`);
	fs.writeFileSync(path.join(__dirname, "equipment-categories.json"), JSON.stringify(out));
	console.log("Wrote equipment-categories.json");
}

main();
