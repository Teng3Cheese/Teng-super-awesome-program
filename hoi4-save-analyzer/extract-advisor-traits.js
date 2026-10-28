// Build-time tool (Node only): resolves the display name for every advisor/leader TRAIT token
// (the one shown as a small tagline next to an advisor, e.g. navy_screen_2 -> "Screens
// (Expert)", silent_workhorse -> "Silent Workhorse") — distinct from the advisor's own slot
// idea, this is the `traits={ "X" }` field inside their `advisor={}` block in the save.
//
// Most of these are plain vanilla HOI4 traits (confirmed directly: even a TPMP-flavored one
// like GER_reich_minister_of_church_affairs turned out to be defined in the BASE GAME's own
// traits_l_english.yml, not a TPMP file) — TPMP only adds a handful of its own on top. So this
// reads vanilla's traits_l_english.yml as the base layer, then layers TPMP's own trait loc
// files over it (mod wins on conflicts), same precedence as the game's own loading order.
//
// Re-run whenever the mod's or base game's trait localisation changes:
//   node extract-advisor-traits.js "<mod folder>" "<base game folder>"
const fs = require("fs");
const path = require("path");

function buildLocMap(files) {
	const map = new Map();
	const lineRe = /^\s*([A-Za-z0-9_]+):\d*\s*"((?:[^"\\]|\\.)*)"/;
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			const m = lineRe.exec(line);
			if (m) map.set(m[1], m[2]);
		}
	}
	return map;
}

function main() {
	const modDir = process.argv[2];
	const gameDir = process.argv[3];
	if (!modDir || !gameDir) {
		console.error('Usage: node extract-advisor-traits.js "<mod folder>" "<base game folder>"');
		process.exit(1);
	}

	const locMap = buildLocMap([
		path.join(gameDir, "localisation", "english", "traits_l_english.yml"),
		path.join(modDir, "localisation", "english", "TPMP_traits_l_english.yml"),
		path.join(modDir, "localisation", "english", "TPMP_UKR_character_traits_l_english.yml"),
	]);

	const out = {};
	for (const [key, value] of locMap) {
		// PDS loc files use a literal "\n" (two characters) for a line break within a string —
		// e.g. "Screens\n(Expert)" — collapse that to a space for a one-line tagline.
		out[key] = value.replace(/\\n/g, " ").trim();
	}

	console.log(`Advisor/leader traits: ${Object.keys(out).length}`);
	fs.writeFileSync(path.join(__dirname, "advisor-traits.json"), JSON.stringify(out));
	console.log("Wrote advisor-traits.json");
}

main();
