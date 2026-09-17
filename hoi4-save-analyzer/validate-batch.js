// One-off validation script (not shipped): parses a whole real weekly batch and sanity-checks
// the PP reconciliation logic (and general parsing) against it. Run with:
//   node validate-batch.js "<folder of .hoi4 files>"
const fs = require("fs");
const path = require("path");
const { parseSave, extractAdvisorRoster, TARGET_TAGS, dateSortKey } = require("./parser.js");
const { buildAllTimelines } = require("./timeline-builder.js");

const LAW_IDEAS = require("./law-ideas.json");

function isLaw(id) {
	return !!LAW_IDEAS[id];
}

// Mirrors computePPReconciliation() in index.template.html.
function computePPReconciliation(t, roster) {
	const out = [];
	for (let i = 1; i < t.ppSeries.length; i++) {
		const prev = t.ppSeries[i - 1], curr = t.ppSeries[i];
		const delta = curr.political_power - prev.political_power;
		const knownSpend = t.advisorEvents
			.filter((e) => e.kind === "appointed" && e.date === curr.date)
			.reduce((sum, e) => sum + (roster.get(e.characterId)?.cost || 0), 0);
		const residual = delta + knownSpend;
		if (residual >= -0.5) continue;
		const lawsThisWindow = t.ppEvents.filter((e) => e.date === curr.date && e.kind === "idea_adopted" && isLaw(e.label));
		out.push({ date: curr.date, prevDate: prev.date, prevPP: prev.political_power, currPP: curr.political_power, delta, knownSpend, unexplained: -residual, lawsThisWindow: lawsThisWindow.map(l => l.label) });
	}
	return out;
}

function main() {
	const dir = process.argv[2];
	const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".hoi4"));
	console.log(`Found ${files.length} .hoi4 files in ${dir}`);

	const t0 = Date.now();
	const saves = [];
	let roster = null;
	let parseErrors = 0;
	for (const f of files) {
		try {
			const text = fs.readFileSync(path.join(dir, f), "utf8");
			const result = parseSave(text);
			result.__file = f;
			saves.push(result);
			if (!roster) roster = extractAdvisorRoster(text);
		} catch (err) {
			parseErrors++;
			console.error(`FAILED to parse ${f}: ${err.message}`);
		}
	}
	const elapsed = Date.now() - t0;
	console.log(`Parsed ${saves.length}/${files.length} files in ${(elapsed/1000).toFixed(1)}s (${(elapsed/saves.length).toFixed(0)}ms/file avg), ${parseErrors} errors.`);

	saves.sort((a, b) => a.dateSortKey - b.dateSortKey);
	console.log(`Date range: ${saves[0].date} (${saves[0].__file}) -> ${saves[saves.length-1].date} (${saves[saves.length-1].__file})`);

	const gameIds = new Set(saves.map(s => s.gameUniqueId).filter(Boolean));
	console.log(`Distinct game_unique_id values: ${gameIds.size}`, gameIds.size > 1 ? [...gameIds] : "");

	// Check for duplicate dates (two files claiming the same in-game moment) which would
	// indicate overlapping/duplicate exports rather than a clean weekly sequence.
	const dateCounts = new Map();
	for (const s of saves) dateCounts.set(s.date, (dateCounts.get(s.date) || 0) + 1);
	const dupes = [...dateCounts.entries()].filter(([, c]) => c > 1);
	if (dupes.length) console.log(`WARNING: duplicate dates found:`, dupes);

	const result = buildAllTimelines(saves, TARGET_TAGS);

	console.log(`\n=== PP reconciliation flags across all ${TARGET_TAGS.length} tracked countries ===`);
	let totalFlags = 0;
	for (const tag of TARGET_TAGS) {
		const t = result.countries[tag];
		if (!t.ppSeries.length) { console.log(`${tag}: no data in this batch`); continue; }
		const recon = computePPReconciliation(t, roster);
		totalFlags += recon.length;
		console.log(`\n--- ${tag} (${t.ppSeries.length} PP snapshots) ---`);
		if (!recon.length) { console.log("  (no unexplained drops)"); continue; }
		for (const r of recon) {
			const lawNote = r.lawsThisWindow.length ? ` [law(s) this window: ${r.lawsThisWindow.join(", ")}]` : " [NO matching law event]";
			console.log(`  ${r.prevDate} -> ${r.date}: ${r.prevPP.toFixed(1)} -> ${r.currPP.toFixed(1)} (Δ${r.delta.toFixed(1)}, known spend ${r.knownSpend}) => ~${r.unexplained.toFixed(1)} PP unexplained${lawNote}`);
		}
	}
	console.log(`\nTotal flagged intervals: ${totalFlags}`);

	// Sanity check: flag anything that looks implausible (huge unexplained amount relative
	// to typical PP scale, which could indicate a parsing bug rather than a real event).
	console.log(`\n=== Plausibility check ===`);
	for (const tag of TARGET_TAGS) {
		const t = result.countries[tag];
		if (!t.ppSeries.length) continue;
		const recon = computePPReconciliation(t, roster);
		for (const r of recon) {
			if (r.unexplained > 1000) console.log(`SUSPICIOUS: ${tag} ${r.date} unexplained=${r.unexplained.toFixed(1)} (very large) — verify manually`);
			if (r.knownSpend < 0) console.log(`BUG: ${tag} ${r.date} negative knownSpend=${r.knownSpend}`);
		}
	}
	console.log("Done.");
}

main();
